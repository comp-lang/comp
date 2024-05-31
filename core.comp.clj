;; todo:
;; expand tagged numbers to (Int$value) and (Float$value)
;; check vector/map for nested runtime ops, change to forms
;; call-mtd not needed with named method
;; compile after def?

(defmethod :to-str 1 nil)

(defmethod :pr-str 1 to-str)

(def* :pr
  (fn* {:params [x _]}
    (js/console.log
      (call-mtd pr-str x))))

(defmethod :invoke 2 nil)

(impl invoke VariadicFunction
  (fn* {:params [f args]}
    (invoke
      (VariadicFunction$func f)
      (concat (VariadicFunction$args f) args))))

(impl invoke Function
  (fn* {:params [f arg]} (f arg)))

(impl invoke Method
  (fn* {:params [m arg]}
    (call-mtd m arg)))

;(def* :map
;  (fn* {:params [f coll map]}
;    (let [coll (to-seq coll)]
;      (if (Int$value (count coll))
;        (lazy-seq
;          (fn* {:params [_]
;               :scope [map f coll]}
;            (cons
;              (call-mtd invoke f (first coll))
;              (map f (rest coll)))))
;        coll))))

(def* :map!
  (fn* {:params [f coll map!]}
    (let [coll (to-seq coll)]
      (if (Int$value (count coll))
        (cons
          (call-mtd invoke f (first coll))
          (map! f (rest coll)))
        coll))))

;(def* :map!
;  (fn* {:params [f coll _]}
;    (let [arr (refs-array (Int$value (count coll)))
;          idx (atom 0)]
;      (do
;        (for-each coll
;          (fn* {:params [args _]
;               :scope [f coll arr]}
;            (let [f (first args)
;                  args (rest args)
;                  coll (first args)
;                  args (rest args)
;                  arr (first args)]
;              (refs-array-set
;

;; todo: escape double quotes
(impl pr-str String
  (fn* {:params [s]}
    (concat-str "\""
      (concat-str s "\""))))

(impl to-str Nil (fn* {:params [_]} "nil"))
(impl to-str True (fn* {:params [_]} "true"))
(impl to-str False (fn* {:params [_]} "false"))
(impl to-str String (fn* {:params [s]} s))

(impl to-str Int
  (fn* {:params [i]}
    (i64->string (Int$value i))))

(impl to-str Symbol
  (fn* {:params [sym]}
    (let [ns (Symbol$namespace sym)
          nm (Symbol$name sym)]
      (if ns
        (concat-str ns
          (concat-str "/" nm))
        nm))))

(impl to-str Keyword
  (fn* {:params [sym]}
    (let [ns (Keyword$namespace sym)
          nm (Keyword$name sym)]
      (concat-str ":"
        (if ns
          (concat-str ns
            (concat-str "/" nm))
          nm)))))

(impl to-str Vector
  (fn* {:params [vec]}
    (let [n (Int$value (count vec))]
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
  (fn* {:params [m]}
    (if (Int$value (count m))
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

(impl to-str Function
  (fn* {:params [f]}
    "#function"))

(def* :consume-seq
  (fn* {:params [seq f]}
    (if (Int$value (count seq))
      (cons (first seq) (f (rest seq)))
      seq)))

(impl to-str Seq
  (fn* {:params [seq]}
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

(defmethod :syntax-quote 1 (fn* {:params [x]} x))

(def* :syntax-quote-seq
  (fn* {:params [form f]}
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
                  (call-mtd syntax-quote head)))
              (cons () ())))
          (cons (f (rest form)) ())))
      ())))

(impl syntax-quote Seq
  (fn* {:params [form]}
    (syntax-quote-seq form)))

(impl syntax-quote Vector
  (fn* {:params [vec]}
    (cons 'to-vec
      (cons
        (call-mtd syntax-quote (to-seq vec))
        ()))))

(def* :not
  (fn* {:params [x _]}
    (if (eq x false)
      true
      (if (eq x nil)
        true
        false))))

(def* :+
  (fn* {:params [x y _]}
    (Int$new
      (i64/add
        (Int$value x)
        (Int$value y)))))

(def* :inc (fn* {:params [x _]} (+ x 1)))

(def* :-
  (fn* {:params [x y _]}
    (Int$new
      (i64/sub
        (Int$value x)
        (Int$value y)))))

(def* :dec (fn* {:params [x _]} (- x 1)))

(def* :*
  (fn* {:params [x y _]}
    (Int$new
      (i64/mul
        (Int$value x)
        (Int$value y)))))

(def* :<
  (fn* {:params [x y _]}
    (if (i64/lt_u (Int$value x) (Int$value y))
      true
      false)))

(def* :>
  (fn* {:params [x y _]}
    (if (i64/gt_u (Int$value x) (Int$value y))
      true
      false)))

;(def* :factorial
;  (fn* {:params [x f]}
;    (if (< x 2)
;      x
;      (* x (f (- x 1))))))
;
;(pr (factorial 7))

(def* :string-ends-with
  (fn* {:params [string substring _]}
    (string-matches-at string substring
      (Int$new
        (i64/sub
          (Int$value (String$length string))
          (Int$value (String$length substring)))))))

(def* :gensym-counter (atom 0))

(impl syntax-quote Symbol
  (fn* {:params [sym]}
    (let [ns (Symbol$namespace sym)
          nm (Symbol$name sym)
          nm (if (not ns)
               (if (string-ends-with nm "#")
                 (concat-str
                   (concat-str
                     (substring-until nm 0 (- (String$length nm) 1))
                     "__gensym__")
                   (to-str (call-mtd deref gensym-counter)))
                 nm)
               nm)]
      (cons 'symbol
        (cons ns
          (cons nm ()))))))

(def* :macros (atom {}))

(impl expand-form Seq
  (fn* {:params [form]}
    (if (Int$value (count form))
      (let [head (first form)
            tail (rest form)
            special
              (if (Symbol$instance head)
                (if (eq head 'syntax-quote)
                  (let [gensym-num (call-mtd deref gensym-counter)
                        form (call-mtd syntax-quote (first tail))]
                    (do (call-mtd reset! gensym-counter (inc gensym-num))
                        (call-mtd expand-form form)))
                  (let [head (call-mtd expand-form head)
                        macro (get (call-mtd deref macros) head nil)]
                    (if macro
                      (call-mtd expand-form (macro tail))
                      nil)))
                nil)]
        (if special special
          (cons
            (call-mtd expand-form head)
            (map! expand-form tail))))
      form)))

(def* :curr-ns (atom (list 'comp.core)))

(def* :aliases (atom {}))

;; todo: throw if namespaced
(def* :store-alias
  (fn* {:params [sym _]}
    (let [ns (Symbol$name (first (call-mtd deref curr-ns)))
          full (symbol ns (Symbol$name sym))]
      (call-mtd reset! aliases
        (assoc
          (assoc (call-mtd deref aliases) sym full)
          full full)))))

(compile)

(call-mtd reset! macros
  (assoc (call-mtd deref macros) 'defmacro
    (fn* {:params [args _]}
      (let [nm (Symbol$name (first args))
            fn (first (rest args))]
       `(do (compile)
          (store-alias (symbol nil ~nm))
          (call-mtd reset! macros
            (assoc
              (call-mtd deref macros)
              (get (call-mtd deref aliases) (symbol nil ~nm) nil)
              ~fn)))))))

(compile)

(defmacro or
  (fn* {:params [args _]}
   `(let [x# ~(first args)]
      (if x# x#
       ~(first (rest args))))))

(defmacro fn
  (fn* {:params [args _]}
    (let [config {}
          nm (first args)
          params (conj (nth args 1 nil) nm)
          config (assoc config :params params)]
     `(fn* ~config ~(nth args 2 nil)))))

(defmacro def
  (fn* {:params [args _]}
    (let [nm (Symbol$name (first args))]
     `(do (compile)
        (store-alias (symbol nil ~nm))
        (let [full (get (call-mtd deref aliases) (symbol nil ~nm) nil)
              kw (keyword (Symbol$namespace full) (Symbol$name full))]
          (def* kw ~(nth args 1 nil)))))))

(pr `x#)
(pr `1)
(pr `a)
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
(pr (map! inc [4 5 6]))
(pr (comp.core/or 17 "this should not print"))
(pr (comp.core/or nil "this should print"))

(impl expand-form Symbol
  (fn* {:params [s]}
    (get (call-mtd deref aliases) s s)))
    ;(let [ss (get (call-mtd deref aliases) s nil)]
    ;  (if ss
    ;    ss
    ;    (if ss
    ;      (call-mtd expand-form ss)
    ;      (throw s
    ;        (concat-str "symbol not found: " (to-str s))))))))

