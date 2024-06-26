;; todo:
;; expand tagged numbers to (Int$value) and (Float$value)
;; check vector/map for nested runtime ops, change to forms
;; comment in list before close parens adds extra argument
;; compile after def?
;; replace call-mtd with general form to limit args

(defmethod :to-str 2 nil)

(defmethod :pr-str 2
  (fn {:params [x _]}
    (call-mtd to-str x to-str)))

(defmethod :syntax-quote 2 (fn {:params [x _]} x))

(compile)

(def :pr
  (fn {:params [x _]}
    (js/console.log
      (pr-str x))))

(def :map
  (fn {:params [f coll map]}
    (let [coll (to-seq coll)]
      (if (Int$value (count coll))
        (lazy-seq
          (fn {:params [_]
               :scope [map f coll]}
            (cons
              (f (first coll))
              (map f (rest coll)))))
        coll))))

;(def :map!
;  (fn {:params [f coll map!]}
;    (let [coll (to-seq coll)]
;      (if (Int$value (count coll))
;        (cons
;          (f (first coll))
;          (map! f (rest coll)))
;        coll))))

;(def :map!
;  (fn {:params [f coll _]}
;    (let [cnt (count coll)
;          arr (array cnt)
;          idx (atom 0)]
;      (do
;        (loop []
;          (let [n (deref idx)]
;            (if (i64/lt_u (Int$value n) (Int$value cnt))
;              (let [el (nth coll n nil)
;                    el (f el)]
;                (do (array-set arr n el)
;                    (reset! idx
;                      (Int$new
;                        (i64/add (Int$value n) (Int$value 1))))
;                    (recur)))
;              nil)))
;        (to-seq arr)))))

;; todo: escape double quotes
(impl pr-str String
  (fn {:params [s _]}
    (concat-str "\""
      (concat-str s "\""))))

(impl to-str Nil (fn {:params [_ _]} "nil"))
(impl to-str True (fn {:params [_ _]} "true"))
(impl to-str False (fn {:params [_ _]} "false"))
(impl to-str String (fn {:params [s _]} s))

(impl to-str Int
  (fn {:params [i _]}
    (i64->string (Int$value i))))

(impl to-str Symbol
  (fn {:params [sym _]}
    (let [ns (Symbol$namespace sym)
          nm (Symbol$name sym)]
      (if ns
        (concat-str ns
          (concat-str "/" nm))
        nm))))

(impl to-str Keyword
  (fn {:params [sym _]}
    (let [ns (Keyword$namespace sym)
          nm (Keyword$name sym)]
      (concat-str ":"
        (if ns
          (concat-str ns
            (concat-str "/" nm))
          nm)))))

(def :map!
  (fn {:params [f coll _]}
    (let [cnt (count coll)]
      (if (Int$value cnt)
        (to-seq
          (for-each coll (array cnt)
            (fn {:params [el accum i _] :scope [f]}
              (array-set accum i (f el)))))
        ()))))

(impl to-str Vector
  (fn {:params [vec _]}
    (let [cnt (Int$value (count vec))
          n (Int$new (i64/sub cnt (Int$value 1)))]
      (if cnt
        (for-each vec "["
          (fn {:params [el accum i _] :scope [n]}
            (let [accum (concat-str accum (pr-str el))]
              (if (i64/lt_u (Int$value i) (Int$value n))
                (concat-str accum " ")
                (concat-str accum "]")))))
        "[]"))))

(impl to-str HashMap
  (fn {:params [m _]}
    (let [cnt (Int$value (count m))
          n (Int$new (i64/sub cnt (Int$value 1)))]
      (if cnt
        (for-each m "{"
          (fn {:params [kv accum i _] :scope [n]}
            (let [k (pr-str (LeafNode$key kv))
                  accum (concat-str (concat-str accum k) " ")
                  v (pr-str (LeafNode$val kv))
                  accum (concat-str accum v)]
              (if (i64/lt_u (Int$value i) (Int$value n))
                (concat-str accum " ")
                (concat-str accum "}")))))
        "{}"))))

(impl to-str Function
  (fn {:params [f _]}
    "#function"))

(impl to-str Seq
  (fn {:params [seq _]}
    (let [cnt (Int$value (count seq))]
      (if cnt
        (let [n (Int$new (i64/sub cnt (Int$value 1)))]
          (for-each seq "("
            (fn {:params [el accum i _] :scope [n]}
              (let [accum (concat-str accum (pr-str el))]
                (if (i64/lt_u (Int$value i) (Int$value n))
                  (concat-str accum " ")
                  (concat-str accum ")"))))))
        "()"))))

(compile)

;; todo: handle splicing-unquote
(impl syntax-quote Seq
  (fn {:params [form _]}
    (let [cnt (Int$value (count form))]
      (if cnt
        (let [accum (array (Int$new (i64/add cnt (Int$value 1))))]
          (to-seq
            (for-each form
              (array-set accum 0 (symbol nil "list"))
              (fn {:params [el accum i _]}
                (let [el (if (if (Seq$instance el)
                               (if (eq (first el) 'unquote)
                                 true
                                 false)
                               false)
                           (nth el 1 nil)
                           (syntax-quote el))]
                  (array-set accum
                    (Int$new (i64/add (Int$value i) (Int$value 1)))
                    el))))))
       ()))))

(impl syntax-quote Vector
  (fn {:params [vec _]}
    (list
      (symbol nil "to-vec")
      (syntax-quote (to-seq vec)))))

(def :not
  (fn {:params [x _]}
    (if (eq x false)
      true
      (if (eq x nil)
        true
        false))))

(def :+
  (fn {:params [x y _]}
    (Int$new
      (i64/add
        (Int$value x)
        (Int$value y)))))

(def :inc (fn {:params [x _]} (+ x 1)))

(def :-
  (fn {:params [x y _]}
    (Int$new
      (i64/sub
        (Int$value x)
        (Int$value y)))))

(def :dec (fn {:params [x _]} (- x 1)))

(def :*
  (fn {:params [x y _]}
    (Int$new
      (i64/mul
        (Int$value x)
        (Int$value y)))))

(def :<
  (fn {:params [x y _]}
    (if (i64/lt_u (Int$value x) (Int$value y))
      true
      false)))

(def :>
  (fn {:params [x y _]}
    (if (i64/gt_u (Int$value x) (Int$value y))
      true
      false)))

(def :string-ends-with
  (fn {:params [string substring _]}
    (string-matches-at string substring
      (Int$new
        (i64/sub
          (Int$value (String$length string))
          (Int$value (String$length substring)))))))

(def :gensym-counter (atom 0))

;; todo: pass environment as arg
(impl syntax-quote Symbol
  (fn {:params [sym _]}
    (let [ns (Symbol$namespace sym)
          nm (Symbol$name sym)
          nm (if (not ns)
               (if (string-ends-with nm "#")
                 (concat-str
                   (concat-str
                     (substring-until nm 0 (- (String$length nm) 1))
                     "__gensym__")
                   (to-str (deref gensym-counter)))
                 nm)
               nm)]
      (list (symbol nil "symbol") ns nm))))

(def :special-forms (atom {}))

(impl expand-form Seq
  (fn {:params [form env]}
    (if (Int$value (count form))
      (let [head (first form)
            tail (rest form)
            special
              (if (Symbol$instance head)
                (if (eq head (symbol nil "syntax-quote"))
                  (let [gensym-num (deref gensym-counter)
                        form (syntax-quote (first tail))]
                    (do (reset! gensym-counter (inc gensym-num))
                        (call-mtd expand-form form env)))
                  (let [head (call-mtd expand-form head env)
                        special (get (deref special-forms) head nil)]
                    (if special (special tail env) nil)))
                nil)]
        (if special special
          (map!
            (fn {:params [form _] :scope [env]}
              (call-mtd expand-form form env))
            form)))
      form)))

(def :curr-ns (atom (list 'comp.core)))

(def :aliases (atom {}))

;; todo: throw if namespaced
(def :store-alias
  (fn {:params [alias sym _]}
    (do
      (reset! aliases
        (assoc (deref aliases) alias sym))
      nil)))

;(store-alias 'do 'do)
;(store-alias 'compile 'compile)
;(store-alias 'store-ns-alias 'store-ns-alias)
;(store-alias 'symbol 'symbol)
;(store-alias 'let 'let)
;(store-alias 'def 'def)

(def :store-ns-alias
  (fn {:params [alias _]}
    (let [ns (Symbol$name (first (deref curr-ns)))
          full (symbol ns (Symbol$name alias))]
      (do (store-alias alias full)
          (store-alias full full)))))

(compile)

(reset! special-forms
  (assoc (deref special-forms) 'defspecial
    (fn {:params [args env _]}
      (let [nm (Symbol$name (first args))
            fn (nth args 1 nil)]
        (call-mtd expand-form
         `(do (compile)
            (store-ns-alias (symbol nil ~nm))
            (reset! special-forms
              (assoc
                (deref special-forms)
                (get (deref aliases) (symbol nil ~nm) nil)
                ~fn)))
          env)))))

(compile)

(defspecial or
  (fn {:params [args env _]}
    (call-mtd expand-form
     `(let [x# ~(first args)]
        (if x# x#
         ~(nth args 1 nil)))
      env)))

(defspecial fn
  (fn {:params [args env _]}
    (let [config {}
          nm (first args)
          params (conj (nth args 1 nil) nm)
          config (assoc config :params params)]
      (list 'fn config
        (call-mtd expand-form (nth args 2 nil) env)))))

(defspecial def
  (fn {:params [args env _]}
    (let [nm (Symbol$name (first args))]
      (list 'do (list 'compile)
        (list 'store-ns-alias (list 'symbol nil nm))
        (list 'let
          (to-vec
            (list
              'full
              (list 'get
                (list 'deref 'aliases)
                (list 'symbol nil nm)
                nil)
              'kw
              (list 'keyword
                (list 'Symbol$namespace 'full)
                (list 'Symbol$name 'full))))
          (list 'def 'kw
            (call-mtd expand-form (nth args 1 nil) env)))))))

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

;(impl expand-form Symbol
;  (fn {:params [s env]}
;    ;(get (deref aliases) s s)))
;    (let [ss (get (deref aliases) s nil)]
;      (if ss
;        ss
;        (if ss
;          (call-mtd expand-form ss env)
;          s)))))
;          ;(throw s
;          ;  (concat-str "symbol not found: " (to-str s))))))))
;
;(compile)
;
