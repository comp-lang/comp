# Memory Management

## Reference Counting

In chapter 1, we mentioned that most types have a reference count field. This field is used to prevent freeing slots while they're still being used.

Each new instance starts with a reference count of zero. When the instance is added to a collection, set as the value of an Atom, etc, the reference count is atomically incremented. When it is removed from the collection, Atom, etc, the reference count is atomically decremented. If the reference count was zero before decrementing, then the memory slot is freed.

But what about instances that are never added to collections? These also need to be freed when they fall out of scope.

Consider the following function:

```
(fn [a]
  (let [b (+ a 1)]
    (* (+ b 7) 5)))
```

You can think of this being expanded to something like this:

```
(fn [a]
  (let [b (+ a 1)
        c (+ b 7)
        d (* c 5)]
    (free b)
    (free c)
    d))
```

`b` and `c` are freed, but not `d`, because it's the return value.

When Comp compiles a function, it maintains an array of all local values that need to be freed at the end.
