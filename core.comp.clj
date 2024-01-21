;; todo:
;; expand tagged numbers to (Int$value) and (Float$value)
;; check vector/map for nested runtime ops, change to forms

(cons :a ())
(cons :a ())
(cons :a ())
(cons :a ())
(cons :a ())

(defmethod 'to-str 1 nil)

(defmethod 'pr-str 1 to-str)

(def 'pr
  (fn _ [x]
    (js/console.log (call-mtd pr-str x))))

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
                 :scope (cons map (cons f (cons coll ())))}
            (let [map (first args)
                  args (rest args)
                  f (first args)
                  args (rest args)
                  coll (first args)]
              (cons
                (call-mtd invoke f (first coll))
                (map f (rest coll))))))
        coll))))

;; todo: escape double quotes
(impl pr-str String
  (fn _ [s]
    (concat-str "\""
      (concat-str s "\""))))

(impl to-str Nil (fn _ [_] "nil"))
(impl to-str True (fn _ [_] "true"))
(impl to-str False (fn _ [_] "false"))
(impl to-str String (fn _ [s] s))

(impl to-str Int
  (fn _ [i]
    (i64->string (Int$value i))))

(impl to-str Symbol
  (fn _ [sym]
    (let [ns (Symbol$namespace sym)
          nm (Symbol$name sym)]
      (if ns
        (concat-str ns
          (concat-str "/" nm))
        nm))))

(impl to-str Keyword
  (fn _ [sym]
    (let [ns (Keyword$namespace sym)
          nm (Keyword$name sym)]
      (concat-str ":"
        (if ns
          (concat-str ns
            (concat-str "/" nm))
          nm)))))

(impl to-str Vector
  (fn _ [vec]
    (let [n (Int$value (Vector$count vec))]
      (if n
        (let [i (Int$value 0)
              s (atom "[")]
          (loop [vec s]
            (let [el (call-mtd pr-str (nth vec (Int$new i) nil))
                  new-s (concat-str (call-mtd deref s) el)]
              (if (i64/eq i (i64/sub n (Int$value 1)))
                (concat-str new-s "]")
                (do
                  (call-mtd reset! s (concat-str new-s " "))
                  (set-local i (i64/add i (Int$value 1)))
                  (recur))))))
        "[]"))))

(impl to-str HashMap
  (fn _ [m]
    (if (Int$value (HashMap$count m))
      (let [m (atom (to-seq m))
            s (atom "{")]
        (loop [m s]
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
              (concat-str new-s "}")))))
      "{}")))

(impl to-str Seq
  (fn _ [seq]
    (if (Int$value (count seq))
      (let [seq (atom seq)
            s (atom "(")]
        (loop [seq s]
          (let [val (call-mtd pr-str (first (call-mtd deref seq)))
                new-s (concat-str (call-mtd deref s) val)
                seq (call-mtd reset! seq (rest (call-mtd deref seq)))]
            (if (Int$value (count seq))
              (do
                (call-mtd reset! s (concat-str new-s " "))
                (recur))
              (concat-str new-s ")")))))
      "()")))

(compile)

(defmethod 'syntax-quote 1 (fn _ [x] x))

(impl syntax-quote Seq
  (fn f [form]
    (if (Int$value (count form))
      (cons 'concat
        (cons
          (cons 'cons
            (cons
;; todo: this should only happen the first time
;; break rest into separate function
              (let [head (first form)]
                (if
                  (if (Seq$instance head)
                    (eq (first head) 'unquote)
                    false)
                  (first (rest head))
                  (call-mtd syntax-quote (inc-refs head))))
              (cons () ())))
          (do (cons (f (rest form)) ()))))
      ())))

(impl syntax-quote Vector
  (fn _ [vec]
    (cons 'to-vec
      (cons
        (call-mtd syntax-quote (to-seq vec))
        ()))))

(def 'not
  (fn _ [x]
    (if (eq x false)
      true
      (if (eq x nil)
        true
        false))))

(def '+
  (fn _ [x y]
    (Int$new
      (i64/add
        (Int$value x)
        (Int$value y)))))

(def 'inc (fn _ [x] (+ x 1)))

(def '-
  (fn _ [x y]
    (Int$new
      (i64/sub
        (Int$value x)
        (Int$value y)))))

(def '<
  (fn _ [x y]
    (if (i64/lt_u (Int$value x) (Int$value y))
      true
      false)))

(def 'dec (fn _ [x] (- x 1)))

(def 'string-ends-with
  (fn _ [string substring]
    (string-matches-at string substring
      (Int$new
        (i64/sub
          (Int$value (String$length string))
          (Int$value (String$length substring)))))))

(def 'gensym-counter (atom 0))

(impl syntax-quote Symbol
  (fn f [sym]
    (let [ns (Symbol$namespace sym)
          nm (Symbol$name sym)
          nm (if (not ns)
               (if (string-ends-with nm "#")
                 (concat-str
                   (concat-str
                     (substring-until nm 0 (- (String$length nm) 1))
                     "__gensym__")
                   (to-str (call-mtd deref gensym-counter)))
                 (inc-refs nm))
               (inc-refs nm))]
      (cons 'symbol
        (cons ns
          (cons nm ()))))))

(def 'aliases (atom {}))

(def 'macros (atom {}))

(impl expand-form Seq
  (fn _ [form]
    (if (Int$value (count form))
      (let [head (call-mtd expand-form (first form))
            tail (rest form)
            special
              (if (Symbol$instance head)
                (if (eq head 'syntax-quote)
                  (let [gensym-num (call-mtd deref gensym-counter)
                        form (call-mtd syntax-quote (first tail))]
                    (do (call-mtd reset! gensym-counter (inc gensym-num))
                        (call-mtd expand-form form)))
                  (let [macro (get (call-mtd deref macros) head nil)]
                    (if macro
                      (do (inc-vector-seq-refs form)
                          (call-mtd expand-form (macro tail)))
                      nil)))
                nil)]
        (if special special
          (cons (inc-refs head) (map expand-form tail))))
      form)))

(compile)

(call-mtd reset! macros
  (assoc (call-mtd deref macros) 'defmacro
    (fn _ [args]
      (let [nm (first args)
            fn (first (rest args))]
       `(do (compile)
          (call-mtd reset! macros
            (assoc (call-mtd deref macros) ~nm ~fn)))))))

(compile)

(defmacro 'or
  (fn _ [args]
   `(let [x# ~(first args)]
      (if x# x#
       ~(first (rest args))))))

(pr `x#)
(pr `(a))
(pr `(1 (2 3)))
(pr (string-length "abc"))
(pr (substring "abcd" 1 3))
(pr (index-of-codepoint "abcd" 99))
(pr (hash "abc"))
(pr (eq 1 2))
(pr (Method$instance deref))
(pr (concat-str "a" "b"))
(pr [1 2 3])
(pr '(1 2 3))
(pr (map inc [1 2 3]))
(pr (or 17 "this should not print"))
(pr (or nil "this should print"))

;(impl expand-form Symbol
;  (fn _ [s]
;    (let [s* (get (call-mtd deref aliases) s nil)]
;      (if s*
;        s*
;        (throw s
;          (concat-str "symbol not found: " (call-mtd to-str s)))))))
