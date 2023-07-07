# How I built Comp

From a user perspective, Comp is very similar to Clojure. But it is built from the ground up in WebAssembly & Javascript, and an understanding of its internal structure may help the user appreciate some important distinctions.

## 1. Data

What does Comp see when you instantiate, say, an integer? All Comp data is stored in a WebAssembly memory buffer, which is like a big array that holds nothing but numbers. Here's what is stored for the integer 7:

```
│ 00 00 00 04 │ 00 00 00 00 │ 00 00 00 00 00 00 00 07 │
├─────────────┼─────────────┼─────────────────────────┤
│ Type Number │ Ref. Count  │ Value                   │
│ 32-bit int  │ 32-bit int  │ 64-bit int              │
```
