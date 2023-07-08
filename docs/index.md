# How I built Comp

From a user perspective, Comp is very similar to Clojure. But it is built from the ground up in WebAssembly & Javascript, and an understanding of its internal structure may help the user appreciate some important distinctions.

1. [Internal Data Representation](data-representation)
2. Internal Memory Management
    - (a) [Freeing Slots](freeing-slots)
    - (b) [Allocating Slots](allocating-slots)
