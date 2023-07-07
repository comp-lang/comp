# How I built Comp

From a user perspective, Comp is very similar to Clojure. But it is built from the ground up in WebAssembly & Javascript, and an understanding of its internal structure may help the user appreciate some important distinctions.

## Data

What does Comp see when you instantiate, say, an Integer? All Comp data is stored in WASM memory, which is like a big array that holds nothing but numbers. Here's what is stored for the Integer 7 (each pair of hexadecimal digits represents a byte):

```
│ 00 00 00 03 │ 00 00 00 00 │ 00 00 00 00 00 00 00 07 │
├─────────────┼─────────────┼─────────────────────────┤
│ Type Number │ Ref. Count  │ Value                   │
│ i32         │ i32         │ i64                     │
```

The byte address where this data is stored in memory is represented by a 32-bit integer (i32).

The first thing WASM sees at this address is an **i32** type number (3). This is the first field for all types, so WASM always knows to load an **i32** from there. The type number is used for polymorphism, which we'll discuss later.

After the type number is stored an **i32** reference counter, which is used for memory management. More on that below. This is also standard for most types.

Finally, there is a field that is unique to the Integer type: an **i64** containing the number's actual value.

Float is similar to Integer, but with an **f64** instead of **i64**:

```
│ 00 00 00 04 │ 00 00 00 00 │ 00 00 00 00 00 00 00 00 │
├─────────────┼─────────────┼─────────────────────────┤
│ Type Number │ Ref. Count  │ Value                   │
│ i32         │ i32         │ f64                     │
```

Obviously, there are more complex types, but we'll get to them later. First, let's look at a few simpler ones.

### Nil, False, and True

Nil, False, and True have no fields but their type numbers: 0, 1, and 2, respectively. There is only one of each in Comp, stored at static locations in memory. Nil is stored at address 0, False at 260, and True at 264. At each of these addresses, only the respective type numbers are stored.

## Low-Level Memory Management

So if Nil is stored at address 0 and False at 260, what's in between? Addresses 4-256 are used for memory management.

### Freeing Slots

Every Comp value must have at least 4 bytes (for the type number). The maximum size for a single value is 256 bytes (enough to hold dozens of **i32** fields).

Let's say we want to free an Integer stored at address 1024. The size of the Integer type (as we saw above) is 16 bytes. First we'll clear bytes 1024-1039, then we'll store 1024 at address 16.

The next time we need a 16-byte value (could be Integer, Float, or any other 16-byte type), first we'll check address 16 to see if a 16-byte slot was previously freed. In this case, we'll find 1024 there, so we know we can reuse that slot for the new value.

What if, after freeing the Integer at address 1024, we free a Float at address 1040? At this point, 1024 is stored at address 16, and we don't want to just overwrite it.

Before storing 1040 at address 16, we need to load the **i32** already stored there, store *it* at address 1040, and *then* store 1040 at address 16.

The next time we create a 16-byte value, we'll load 1040 from address 16, but before storing the new value at address 1040, we'll load the number already stored there (1024) and put it back in address 16.

This way, we maintain a chain from the first freed slot to the most recent one. If A is the most recently freed 16-byte slot, its address is stored at address 16. If B was freed before A, its address is stored in A. If C was freed before B, its address is stored in B, and so on.

(FYI we're using WASM atomic operations to swap the values in address 16 so multiple threads can free slots without race conditions. We'll talk more about threads much later).

Each type uses the address corresponding to its size — address 4 for 4-byte types, address 8 for 8-byte types, and so on, up to the maximum of 256.

Since we are storing 32-bit addresses, type sizes must be in increments of 4 bytes. (We couldn't have a type size of 18, for instance, because that would put it right in the middle of the 4-byte slot at address 16).

Initially, the number at each of these addresses is 0, and it will be 0 again when we get to the end of the chain (i.e. reuse the last freed slot). Whenever a 0 is loaded from one of these addresses, then we need to allocate a new slot.

### Allocating Slots

We've already discussed one part of the allocation process: check the address corresponding to the type size to see if there is an available freed slot.

When there's not, the next step is to go to the end of the 

[//]: # (
One implication of the above is that type sizes must be in 4-byte increments
)
