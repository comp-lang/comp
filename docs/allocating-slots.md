# Memory Management

## Allocating Slots

We've already discussed one part of the allocation process: check the slot register (4-256) corresponding to the type size to see if there is an available freed slot.

When there's not (i.e. when the slot register contains 0), the next step is to reserve the next available address in memory. We keep track of this at address 268 (right after True). We'll call this the next-address register.

Address 272 is used to keep track of the total number of bytes currently available in memory. We'll call this the avail-mem register. More on this below.

So initially, the value stored in the next-address register is 276 (the address after the avail-mem register).

If we want to instantiate a new Integer, we'll check slot register 16, find that its value is zero (since no slots were previously freed), then check the next-address register and find that its value is 276. This is where we'll store the new Integer.

Now we need to increase the value of the next-address register by 16 so that any data instantiated after the Integer will be stored at address 292.

Before proceeding, we need to make sure this addition does not overflow the 32-bit address space. The new address should always be greater than the previous value of next-address (if the addition overflows, the answer will wrap around to zero). If not, then we have run out of memory and throw an exception.

Then we must check if we need to add memory to hold the instantiated data. Comp starts out with only one page (64 Kib) of WASM memory, which is expanded as needed.

To do this, we compare the new address to the value of the avail-mem register. If the new address is greater than or equal to avail-mem, then we need to expand memory to fit the instantiated data.

The maximum size of WASM memory is 2^32 bytes or 4 GiB, but we already checked above that we have not exceeded that amount, so we are safe to grow the memory as needed at this point.

Each step of this process is conducted in a thread-safe manner without locking, using atomic operations and loops. See the internal `get_next_address` function for details.

Let's conclude by reviewing what happens when there is a previously freed slot available. We need to load the address in the slot register, and if it's not zero, then load the value in *that* address and store it in the slot register.

This is a multi-step process. How do we prevent other threads from loading the same address from the slot register while continuing the other steps?

We load the address from the slot register using the `i32.atomic.rmw.xchg` operation, which allows us to atomically store zero at that address and read the prior value from it simultaneously. Thus, if another thread tries to read from that slot register, it will read zero and proceed as if there are no freed slots. Once the next freed slot in the chain is stored in the slot register, then another thread can safely use it.
