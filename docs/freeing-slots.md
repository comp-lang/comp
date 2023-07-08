# Internal Memory Management

So if Nil is stored at address 0 and False at 260, what's in between? Addresses 4-256 are used for memory management. Let's call them slot registers.

## Freeing Slots

Every Comp value must have at least 4 bytes (for the type number). The maximum size for a single value is 256 bytes (enough to hold dozens of **i32** fields).

Let's say we want to free an Integer stored at address 1024. The size of the Integer type (as we saw above) is 16 bytes. First we'll clear bytes 1024-1039 (the freed slot), then we'll store 1024 (an **i32**) at slot register 16.

The next time we need to create a 16-byte value (could be Integer, Float, or any other 16-byte type), first we'll check slot register 16 to see if a 16-byte slot was previously freed. In this case, we'll find 1024 there, so we know we can reuse that slot for the new value.

What if, after freeing slot 1024, we free a Float at address 1040? At this point, 1024 is stored at slot register 16, and we don't want to just overwrite it because we can use it for a future value.

Before storing 1040 at slot register 16, we need to load the **i32** already stored there, store *it* at address 1040, and *then* store 1040 at slot register 16.

The next time we create a 16-byte value, we'll load 1040 from slot register 16, but before storing the new value at address 1040, we'll load the number already stored there (1024) and put it back in slot register 16.

This way, we maintain a chain from the first freed slot to the most recent one. If A is the most recently freed 16-byte slot, its address is stored at slot register 16. If B was freed before A, its address is stored in A. If C was freed before B, its address is stored in B, and so on.

(FYI we're using WASM atomic operations to swap the values in slot register 16 so multiple threads can free slots without race conditions. We'll talk more about threads much later).

Each type uses the slot register corresponding to its size — register 4 for 4-byte values, register 8 for 8-byte values, and so on, up to the maximum of 256.

Since we are storing an **i32** in each slot register, type sizes must be in increments of 4 bytes. (We couldn't have a type size of 18 bytes, for instance, because that would put it right in the middle of slot register 16).

Initially, the number at each of these slot registers is 0, and it will be 0 again when we get to the end of the chain (i.e. reuse the last freed slot). Whenever one of these slot registers is set to 0, then we need to allocate a new slot.
