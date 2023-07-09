# Memory Management

## Allocating Slots

We've already discussed one part of the allocation process: check the slot register (4-256) corresponding to the type size to see if there is an available freed slot.

When there's not, the next step is to reserve a new slot at the end of the globally used memory. We keep track of this location at address 268 (right after True). We'll call this the next-address register.

Address 272 is used to keep track of the starting byte of the last page in memory (each page of WASM memory is 2^16 bytes, and you can have a maximum of 2^16 pages, or 2^32 bytes in total). We'll call this the page-start register.

So initially, the value stored in the next-address register is 276 (right after the page-start register).

If we want to instantiate a new Integer, we'll check slot register 16, find that its value is zero (since no slots were previously freed), then check the next-address register and find that its value is 276. This is where we'll store the new Integer.

Now we need to increase the next-address register by 16 so that the next value created will be stored after the Integer. Comp is designed to be thread-safe from the ground up, so we have to assume that multiple threads could be trying to do this simultaneously. We can't allow any gap between reading and updating the value of the next-address register.

Therefore, we do both at once using WASM's i32.atomic.rmw.add operation. This op adds to the value stored in the next-address register and then returns the previous value, so by the time we know the next available address is 276, we've already increased the value of the next-address register to 292. The atomic operation forces all other threads to wait, so when the next thread accesses the next-address register, it will read 292, and there will be no conflict.

Now we know that 16 bytes have been reserved at address 276, and we can safely store the new Integer there.

Eventually, we're going to increase next-address to the point that we need to grow the memory. Initially, Comp starts with a single page of memory (2^16 bytes, or 64 Kib). When we increase next-address as described above, we need to check the new value to see if it goes past the end of currently available memory.

There are actually two checks we need to perform.
