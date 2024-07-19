;(def factorial
;  (fn f [x]
;    (if (i64/gt_u x 1)
;      (i64/mul x (f (i64/sub x 1)))
;      x)))
;
;(pr (factorial 7))
