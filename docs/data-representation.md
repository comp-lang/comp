# Internal Data Representation

What does Comp see when you instantiate, say, an Integer? All Comp data is stored in WASM memory, which is like a big array that holds nothing but numbers. Here's what is stored for the Integer 7 (each pair of hexadecimal digits represents a byte):

```
│ 00 00 00 03 │ 00 00 00 00 │ 00 00 00 00 00 00 00 07 │
├─────────────┼─────────────┼─────────────────────────┤
│ Type Number │ Ref. Count  │ Value                   │
│ i32         │ i32         │ i64                     │
```

The byte address where this data is stored in memory is represented in WASM by a 32-bit integer (i32).

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

## Nil, False, and True

Nil, False, and True have no fields but their type numbers: 0, 1, and 2, respectively. There is only one of each in Comp, stored at static locations in memory. Nil is stored at address 0, False at 260, and True at 264. At each of these addresses, only the respective type numbers are stored.
