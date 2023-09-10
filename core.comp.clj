(defmethod 'invoke 2 nil)

(impl invoke VariadicFunction
  (fn _ [f args]
    (invoke
      (VariadicFunction$func f)
      (concat (VariadicFunction$args f) args))))

(impl invoke Function (fn _ [f arg] (f arg)))

(impl invoke Method
  (fn _ [m arg]
    (call-mtd m arg)))

(def 'map
  (fn map [f coll]
    (let [coll (to-seq coll)]
      (if (Int$value (count coll))
        (lazy-seq
          (fn _ {:params [args]
                 :scope [map f coll]}
            (let [map (first args)
                  args (rest args)
                  f (first args)
                  args (rest args)
                  coll (first args)]
              (cons
                (call-mtd invoke f (first coll))
                (map f (rest coll))))))
        coll))))

(impl syntax-quote Seq
  (fn f [form]
    (if (Int$value (count form))
      (cons 'cons
        (cons (call-mtd syntax-quote (first form))
          (cons (f (rest form)) ())))
      ())))

(def 'aliases (atom {}))

(def 'macros (atom {}))

(impl expand-form Seq
  (fn _ [form]
    (if (Int$value (count form))
      (let [head (call-mtd expand-form (first form))
            tail (rest form)
            special
              (if (Symbol$instance head)
                (let [macro (get (call-mtd deref macros) head nil)]
                  (if macro
                    (macro tail)
                    (if (eq head 'defmacro)
                      (cons 'do (cons form (cons (cons 'compile ()) ())))
                      nil)))
                nil)]
        (if special special
          (cons head (map expand-form tail))))
      form)))

(def 'defmacro
  (fn _ [nm fn]
    (do (call-mtd reset! macros (assoc (call-mtd deref macros) nm fn))
        fn)))

;; impl needs double compile
(compile)
(compile)

(defmacro 'or
  (fn _ [args]
    (cons 'if
      (cons (first args)
        (cons (first args)
          (cons (first (rest args))
            ()))))))

(defmethod 'str 1 nil)

(defmethod 'pr-str 1 str)

(def 'pr
  (fn _ [x]
    (js/console.log (call-mtd pr-str x))))

;; todo: escape double quotes
(impl pr-str String
  (fn _ [s]
    (concat-str "\""
      (concat-str s "\""))))

(impl str Nil (fn _ [_] "nil"))
(impl str True (fn _ [_] "true"))
(impl str False (fn _ [_] "false"))
(impl str String (fn _ [s] s))

(impl str Int
  (fn _ [i]
    (i64->string (Int$value i))))

(impl str Symbol
  (fn _ [sym]
    (let [ns (Symbol$namespace sym)
          nm (Symbol$name sym)]
      (if ns
        (concat-str ns
          (concat-str "/" nm))
        nm))))

(impl str Keyword
  (fn _ [sym]
    (let [ns (Keyword$namespace sym)
          nm (Keyword$name sym)]
      (concat-str ":"
        (if ns
          (concat-str ns
            (concat-str "/" nm))
          nm)))))

(impl str Vector
  (fn _ [vec]
    (let [n (Int$value (Vector$count vec))
          i (Int$value 0)
          s (atom "[")]
      (loop
        (let [el (call-mtd pr-str (nth vec (Int$new i) nil))
              new-s (concat-str (call-mtd deref s) el)]
          (if (i64/eq i (i64/sub n (Int$value 1)))
            (concat-str new-s "]")
            (do
              (call-mtd reset! s (concat-str new-s " "))
              (set-local i (i64/add i (Int$value 1)))
              (recur))))))))

(impl str HashMap
  (fn _ [m]
    (let [m (atom (to-seq m))
          s (atom "{")]
      (loop
        (let [kv (first (call-mtd deref m))
              k (pr-str (LeafNode$key kv))
              v (pr-str (LeafNode$val kv))
              new-s (concat-str (call-mtd deref s)
                      (concat-str k
                        (concat-str " " v)))
              m (call-mtd reset! m (rest (call-mtd deref m)))]
          (if (Int$value (count m))
            (do
              (call-mtd reset! s (concat-str new-s " "))
              (recur))
            (concat-str new-s "}")))))))

(impl str Seq
  (fn _ [seq]
    (if (Int$value (count seq))
      (let [seq (atom seq)
            s (atom "(")]
        (loop
          (let [val (call-mtd pr-str (first (call-mtd deref seq)))
                new-s (concat-str (call-mtd deref s) val)
                seq (call-mtd reset! seq (rest (call-mtd deref seq)))]
            (if (Int$value (count seq))
              (do
                (call-mtd reset! s (concat-str new-s " "))
                (recur))
              (concat-str new-s ")")))))
      "()")))

(def 'inc
  (fn _ [x]
    (Int$new (i64/add (Int$value x) (Int$value 1)))))

(pr `(1 2 3))
(pr (string-length "abc"))
(pr (substring "abcd" 1 3))
(pr (index-of-codepoint "abcd" 99))
(pr (hash "abc"))
(pr (eq 1 2))
(pr (Method$instance deref))
(pr :a)
(pr (concat-str "a" "b"))
(pr [1 2 3])
(pr '(1 2 3))
(pr (map inc [1 2 3]))
(pr (or 17 "this should not print"))
(pr (or nil "this should print"))

(impl expand-form Symbol
  (fn _ [s]
    (let [s* (get (call-mtd deref aliases) s nil)]
      (if s*
        s*
        (throw s
          (concat-str "symbol not found: " (call-mtd str s)))))))
