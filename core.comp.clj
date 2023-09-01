(defmethod 'str 1 nil)

(defmethod 'pr-str 1 str)

(def 'pr
  (fn _ [x]
    (js/console.log (pr-str x))))

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
    (i64->string (Int/value i))))

(impl str Symbol
  (fn _ [sym]
    (let [ns (Symbol/namespace sym)
          nm (Symbol/name sym)]
      (if ns
        (concat-str ns
          (concat-str "/" nm))
        nm))))

(impl str Keyword
  (fn _ [sym]
    (let [ns (Keyword/namespace sym)
          nm (Keyword/name sym)]
      (concat-str ":"
        (if ns
          (concat-str ns
            (concat-str "/" nm))
          nm)))))

(impl str Vector
  (fn _ [vec]
    (let [n (Int/value (Vector/count vec))
          i #0 
          s (atom "[")]
      (loop
        (let [el (pr-str (nth vec (Int/new i) nil))
              new-s (concat-str (deref s) el)]
          (if (i64/eq i (i64/sub n #1))
            (concat-str new-s "]")
            (do
              (reset! s (concat-str new-s " "))
              (set-local i (i64/add i #1))
              (recur))))))))

(impl str HashMap
  (fn _ [m]
    (let [m (atom (seq m))
          s (atom "{")]
      (loop
        (let [kv (first (deref m))
              k (pr-str (LeafNode/key kv))
              v (pr-str (LeafNode/val kv))
              new-s (concat-str (deref s)
                      (concat-str k
                        (concat-str " " v)))
              m (reset! m (rest (deref m)))]
          (if (Int/value (count m))
            (do
              (reset! s (concat-str new-s " "))
              (recur))
            (concat-str new-s "}")))))))

(impl str Seq
  (fn _ [seq]
    (let [seq (atom seq)
          s (atom "(")]
      (loop
        (let [val (str (first (deref seq)))
              new-s (concat-str (deref s) val)
              seq (reset! seq (rest (deref seq)))]
          (if (Int/value (count seq))
            (do
              (reset! s (concat-str new-s " "))
              (recur))
            (concat-str new-s ")")))))))

(defmethod 'invoke 2 nil)

(impl invoke VariadicFunction
  (fn _ [f args]
    (invoke
      (VariadicFunction/func f)
      (concat (VariadicFunction/args f) args))))

(impl invoke Function (fn _ [f arg] (call f arg)))

(impl invoke Method
  (fn _ [m arg]
    (call (Method/main_func m) arg)))

(def 'map
  (fn map [f coll]
    (let [coll (seq coll)]
      (if (Int/value (count coll))
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
    (Int/new (i64/add (Int/value x) #1))))

(pr (map inc [1 2 3]))

(def 'syms (atom {}))

(impl expand-form Symbol
  (fn _ [s]
    (let [s* (get (deref syms) s nil)]
      (if s*
        s*
        (throw s
          (concat-str "symbol not found: " (str s)))))))

(impl expand-form Seq
  (fn _ [s]
    (map expand-form s)))

;; (def 'filter
;;   (fn _ [f coll]
;;     (Seq
;;       (seq coll)
;;       []
;;       (fn build [source accum]
;;         (loop [source source]
;;           (let [x (first source)]
;;             (if (f x)
;;               (Seq/new
;;                 (rest source)
;;                 (append accum x)
;;                 build)
;;               (recur (rest source)))))))))