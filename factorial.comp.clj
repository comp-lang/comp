(def factorial
  (fn f [x]
    (if (> x 1)
      (* x (f (- x 1)))
      x)))

(pr (factorial 7))
