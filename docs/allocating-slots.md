# Internal Memory Management

## Allocating Slots

We've already discussed one part of the allocation process: check the slot register (4-256) corresponding to the type size to see if there is an available freed slot.

When there's not, the next step is to claim a new slot at the end of the globally used memory.

[//]: # (
One implication of the above is that type sizes must be in 4-byte increments
)
