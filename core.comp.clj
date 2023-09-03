(defmethod 'str 1 nil)

(defmethod 'pr-str 1 str)

(def 'pr
  (fn _ [x]
    (js/console.log (pr-str x))))

;; todo: escape double quotes
(impl pr-str String
  (fn _ [s]
    (concat_str "\""
      (concat_str s "\""))))

(impl str Nil (fn _ [_] "nil"))
(impl str True (fn _ [_] "true"))
(impl str False (fn _ [_] "false"))
(impl str String (fn _ [s] s))

(impl str Int
  (fn _ [i]
    (i64_to_string (Int$value i))))

(impl str Symbol
  (fn _ [sym]
    (let [ns (Symbol$namespace sym)
          nm (Symbol$name sym)]
      (if ns
        (concat_str ns
          (concat_str "/" nm))
        nm))))

(impl str Keyword
  (fn _ [sym]
    (let [ns (Keyword$namespace sym)
          nm (Keyword$name sym)]
      (concat_str ":"
        (if ns
          (concat_str ns
            (concat_str "/" nm))
          nm)))))

(impl str Vector
  (fn _ [vec]
    (let [n (Int$value (Vector$count vec))
          i #0 
          s (atom "[")]
      (loop
        (let [el (pr-str (nth vec (Int$new i) nil))
              new-s (concat_str (deref s) el)]
          (if (i64/eq i (i64/sub n #1))
            (concat_str new-s "]")
            (do
              (reset s (concat_str new-s " "))
              (set-local i (i64/add i #1))
              (recur))))))))

(impl str HashMap
  (fn _ [m]
    (let [m (atom (to_seq m))
          s (atom "{")]
      (loop
        (let [kv (first (deref m))
              k (pr-str (LeafNode$key kv))
              v (pr-str (LeafNode$val kv))
              new-s (concat_str (deref s)
                      (concat_str k
                        (concat_str " " v)))
              m (reset m (rest (deref m)))]
          (if (Int$value (count m))
            (do
              (reset s (concat_str new-s " "))
              (recur))
            (concat_str new-s "}")))))))

(impl str Seq
  (fn _ [seq]
    (let [seq (atom seq)
          s (atom "(")]
      (loop
        (let [val (str (first (deref seq)))
              new-s (concat_str (deref s) val)
              seq (reset seq (rest (deref seq)))]
          (if (Int$value (count seq))
            (do
              (reset s (concat_str new-s " "))
              (recur))
            (concat_str new-s ")")))))))

(defmethod 'invoke 2 nil)

(impl invoke VariadicFunction
  (fn _ [f args]
    (invoke
      (VariadicFunction$func f)
      (concat (VariadicFunction$args f) args))))

(impl invoke Function (fn _ [f arg] (call f arg)))

(impl invoke Method
  (fn _ [m arg]
    (call (Method$main_func m) arg)))

(def 'map
  (fn map [f coll]
    (let [coll (to_seq coll)]
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
                (invoke f (first coll))
                (call map f (rest coll))))))
        coll))))

(def 'inc
  (fn _ [x]
    (Int$new (i64/add (Int$value x) #1))))

(pr (string_length "abc"))
(pr (substring "abcd" 1 3))
(pr (index_of_codepoint "abcd" 99))
(pr (hash "abc"))
(pr (eq 1 2))
(pr (Symbol$instance 'a))
(pr (map inc [1 2 3]))

(def 'aliases (atom {}))

(def 'macros (atom {}))

(impl expand-form Seq
  (fn _ [form]
    (let [head (expand-form (first form))
          tail (rest form)
          special
            (if (Symbol$instance head)
              (let [macro (get (deref macros) head nil)]
                (if macro
                  (expand-form (invoke macro tail))
                  nil))
              nil)]
      (if special special
        (cons head (map expand-form tail))))))

(def 'defmacro
  (fn _ [nm fn]
    (do (reset macros (assoc (deref macros) nm fn))
        fn)))

(impl expand-form Symbol
  (fn _ [s]
    (let [s* (get (deref aliases) s nil)]
      (if s*
        s*
        (throw s
          (concat_str "symbol not found: " (str s)))))))
