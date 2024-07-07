;; todo:
;; check vector/map for nested runtime ops, change to forms
;; comment in list before close parens adds extra argument
;; compile after def?
;; replace call-mtd with general form to limit args

(defmethod :to-str 2 nil)

(defmethod :pr-str 2
  (fn {:params [x _]}
    (call-mtd to-str x to-str)))

(defmethod :syntax-quote 2 (fn {:params [x _]} x))

(defmethod :to-sym 2 nil)

(defmethod :get-scope 5
  (fn {:params [x scope inner-env outer-env _]}
    scope))

(compile)

(impl to-sym Symbol (fn {:params [s _]} s))

(impl to-sym Keyword
  (fn {:params [kw _]}
    (symbol
      (Symbol$namespace kw)
      (Symbol$name kw))))

(def :curr-ns (atom (list 'comp.core)))

(def :aliases (atom {}))

;; todo: throw if namespaced
(def :store-alias
  (fn {:params [alias sym _]}
    (reset! aliases
      (assoc (deref aliases)
        (to-sym alias)
        (to-sym sym)))))

(def :store-ns-alias
  (fn {:params [alias _]}
    (let [ns (Symbol$name (first (deref curr-ns)))
          full (symbol ns (Symbol$name alias))]
      (do (store-alias alias full)
          (store-alias full full)))))

(def :def*
  (fn {:params [nm val _]}
    (do (def nm val)
        (store-alias nm nm))))

(def* :pr
  (fn {:params [x _]}
    (js/console.log
      (pr-str x))))

(def* :map
  (fn {:params [f coll map]}
    (let [coll (to-seq coll)]
      (if (i64/gt_u (count coll) 0)
        (lazy-seq
          (fn {:params [_]
               :scope [map f coll]}
            (cons
              (f (first coll))
              (map f (rest coll)))))
        coll))))

(def* :map!
  (fn {:params [f coll _]}
    (to-seq
      (for-each coll (array (count coll)) 0 -1
        (fn {:params [el arr i _] :scope [f]}
          (array-set arr i (f el)))))))

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

(impl to-str Vector
  (fn {:params [vec _]}
    (let [cnt (count vec)
          n (i64/sub cnt 1)]
      (if (i64/gt_u cnt 0)
        (for-each vec "[" 0 -1
          (fn {:params [el accum i _] :scope [n]}
            (let [accum (concat-str accum (pr-str el))]
              (if (i64/lt_u i n)
                (concat-str accum " ")
                (concat-str accum "]")))))
        "[]"))))

(impl to-str HashMap
  (fn {:params [m _]}
    (let [cnt (count m)
          n (i64/sub cnt 1)]
      (if (i64/gt_u cnt 0)
        (for-each m "{" 0 -1
          (fn {:params [kv accum i _] :scope [n]}
            (let [k (pr-str (LeafNode$key kv))
                  accum (concat-str (concat-str accum k) " ")
                  v (pr-str (LeafNode$val kv))
                  accum (concat-str accum v)]
              (if (i64/lt_u i n)
                (concat-str accum " ")
                (concat-str accum "}")))))
        "{}"))))

(impl to-str Function
  (fn {:params [f _]}
    "#function"))

(impl to-str Seq
  (fn {:params [seq _]}
    (let [cnt (count seq)]
      (if (i64/gt_u cnt 0)
        (let [n (i64/sub cnt 1)]
          (for-each seq "(" 0 -1
            (fn {:params [el accum i _] :scope [n]}
              (let [accum (concat-str accum (pr-str el))]
                (if (i64/lt_u i n)
                  (concat-str accum " ")
                  (concat-str accum ")"))))))
        "()"))))

(compile)

;; todo: handle splicing-unquote
(impl syntax-quote Seq
  (fn {:params [form _]}
    (let [cnt (count form)]
      (if (i64/gt_u cnt 0)
        (let [accum (array (i64/add cnt 1))]
          (to-seq
            (for-each form
              (array-set accum 0 (symbol nil "list"))
              0 -1
              (fn {:params [el accum i _]}
                (let [el (if (if (Seq$instance el)
                               (if (eq (first el) 'unquote)
                                 true
                                 nil)
                               nil)
                           (nth el 1 nil)
                           (syntax-quote el))]
                  (array-set accum (i64/add i 1) el))))))
       ()))))

(impl syntax-quote Vector
  (fn {:params [vec _]}
    (list
      (symbol nil "to-vec")
      (syntax-quote (to-seq vec)))))

(def* :string-ends-with
  (fn {:params [string substring _]}
    (string-matches-at string substring
      (i64/sub (String$length string) (String$length substring)))))

(def* :gensym-counter (atom 0))

;; todo: pass environment as arg
(impl syntax-quote Symbol
  (fn {:params [sym _]}
    (let [ns (Symbol$namespace sym)
          nm (Symbol$name sym)
          nm (if ns nm
               (if (string-ends-with nm "#")
                 (concat-str
                   (concat-str
                     (substring-until nm 0 (i64/sub (String$length nm) 1))
                     "__gensym__")
                   (to-str (deref gensym-counter)))
                 nm))]
      (list (symbol nil "symbol") ns nm))))

(def* :special-forms (atom {}))

(impl expand-form Seq
  (fn {:params [form env]}
    (if (i64/gt_u (count form) 0)
      (let [head (first form)
            tail (rest form)
            special
              (if (Symbol$instance head)
                (if (eq head (symbol nil "syntax-quote"))
                  (let [gensym-num (deref gensym-counter)
                        form (syntax-quote (first tail))]
                    (do (reset! gensym-counter (i64/add gensym-num 1))
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

(store-alias 'if 'if)
;(store-alias 'do 'do)
;(store-alias 'compile 'compile)
;(store-alias 'store-ns-alias 'store-ns-alias)
;(store-alias 'symbol 'symbol)
;(store-alias 'let 'let)
;(store-alias 'def 'def)

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

(impl get-scope Symbol
  (fn {:params [sym scope inner-env outer-env _]}
    (if (get inner-env sym nil)
      scope
      (if (get outer-env sym nil)
        (conj scope sym)
        scope))))

(impl get-scope Seq
  (fn {:params [seq scope inner-env outer-env _]}
    (for-each seq scope 0 -1
      (fn {:params [x scope i _]
           :scope [inner-env outer-env]}
        (get-scope x scope inner-env outer-env)))))

(defspecial fn
  (fn {:params [args env _]}
    (let [nm (let [nm (first args)]
               (if (Symbol$instance nm) nm nil))
          params (nth args (if nm 1 0) nil)
          params (conj params nm)
          body (nth args (if nm 2 1) nil)
          scope-env
            (for-each params (deref aliases) 0 -1
              (fn {:params [param env i _]}
                (assoc env param param)))
          scope (get-scope body [] scope-env env)
          config (assoc {} :params params)
          env (for-each scope scope-env 0 -1
                (fn {:params [sym env i _]}
                  (assoc env sym sym)))]
      (list 'fn (assoc config :scope scope)
        (call-mtd expand-form body env)))))

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

(pr {:a 1 :b 2})
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
(pr (map! (fn {:params [x _]} (i64/add x 1)) [4 5 6]))

(impl expand-form Symbol
  (fn {:params [s env]}
    (let [ss (get env s nil)]
      (if ss ss
        (let [ss (get (deref aliases) s nil)]
          (if ss
            (if (eq ss s)
              ss
              (call-mtd expand-form ss env))
            (throw s
              (concat-str "symbol not found: " (to-str s)))))))))

(impl expand-form HashMap
  (fn {:params [form env]}
    (for-each form {} 0 -1
      (fn {:params [kv accum n _]}
        (list (symbol nil "assoc") accum
          (LeafNode$key kv)
          (LeafNode$val kv))))))

(compile)

