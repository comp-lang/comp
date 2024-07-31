;; todo:
;; check vector/map for nested runtime ops, change to forms
;; comment in list before close parens adds extra argument
;; compile after def?
;; replace comp/call-mtd with general form to limit args

(comp/defmethod :comp/to-str 2 nil)

(comp/defmethod :comp/pr-str 2
  (comp/fn (x _) ()
    (comp/call-mtd comp/to-str x comp/to-str)))

(comp/defmethod :comp/syntax-quote 2
  (comp/fn (x _) () x))

(comp/defmethod :comp/to-sym 2 nil)

(comp/defmethod :comp/get-scope 5
  (comp/fn (x scope inner-env outer-env _) ()
    scope))

(comp/compile)

(comp/impl comp/to-sym Symbol (comp/fn (s _) () s))

(comp/impl comp/to-sym Keyword
  (comp/fn (kw _) ()
    (comp/symbol
      (comp.Symbol/namespace kw)
      (comp.Symbol/name kw))))

(comp/def :comp/curr-ns (comp/atom (comp/list 'comp.core)))

(comp/def :comp/aliases (comp/atom {}))

;; todo: throw if namespaced
(comp/def :comp/store-alias
  (comp/fn (alias sym _) ()
    (comp/reset! comp/aliases
      (comp/assoc (comp/deref comp/aliases)
        (comp/to-sym alias)
        (comp/to-sym sym)))))

(comp/def :comp/store-ns-alias
  (comp/fn (alias _) ()
    (comp/let
      (ns (comp.Symbol/name (comp/first (comp/deref comp/curr-ns)))
       full (comp/symbol ns (comp.Symbol/name alias)))
      (comp/do
        (comp/store-alias alias full)
        (comp/store-alias full full)))))

(comp/def :comp/def*
  (comp/fn (nm val _) ()
    (comp/do
      (comp/def nm val)
      (comp/store-alias nm nm))))

(comp/def* :comp/pr
  (comp/fn (x _) ()
    (js/console.log (comp/pr-str x))))

(comp/def* :comp/map
  (comp/fn (f coll map) ()
    (comp/let (coll (comp/to-seq coll))
      (comp/if (i64/gt_u (comp/count coll) 0)
        (comp/lazy-seq
          (comp/fn (_) (map f coll)
            (comp/cons
              (f (comp/first coll))
              (map f (comp/rest coll)))))
        coll))))

(comp/def* :comp/map!
  (comp/fn (f coll _) ()
    (comp/to-seq
      (comp/for-each coll (comp/array (comp/count coll)) 0 -1
        (comp/fn (el arr i _) (f)
          (comp/array-set arr i (f el)))))))

;; todo: escape double quotes
(comp/impl comp/pr-str String
  (comp/fn (s _) ()
    (comp/concat-str "\""
      (comp/concat-str s "\""))))

(comp/impl comp/to-str Nil (comp/fn (_ _) () "nil"))
(comp/impl comp/to-str True (comp/fn (_ _) () "true"))
(comp/impl comp/to-str False (comp/fn (_ _) () "false"))
(comp/impl comp/to-str String (comp/fn (s _) () s))

(comp/impl comp/to-str Int
  (comp/fn (i _) ()
    (comp/i64->string (comp.Int/value i))))

(comp/impl comp/to-str Symbol
  (comp/fn (sym _) ()
    (comp/let
      (ns (comp.Symbol/namespace sym)
       nm (comp.Symbol/name sym))
      (comp/if ns
        (comp/concat-str ns
          (comp/concat-str "/" nm))
        nm))))

(comp/impl comp/to-str Keyword
  (comp/fn (sym _) ()
    (comp/let
      (ns (comp.Keyword/namespace sym)
       nm (comp.Keyword/name sym))
      (comp/concat-str ":"
        (comp/if ns
          (comp/concat-str ns
            (comp/concat-str "/" nm))
          nm)))))

(comp/impl comp/to-str Vector
  (comp/fn (vec _) ()
    (comp/let
      (cnt (comp/count vec)
       n (i64/sub cnt 1))
      (comp/if (i64/gt_u cnt 0)
        (comp/for-each vec "[" 0 -1
          (comp/fn (el accum i _) (n)
            (comp/let (accum (comp/concat-str accum (comp/pr-str el)))
              (comp/if (i64/lt_u i n)
                (comp/concat-str accum " ")
                (comp/concat-str accum "]")))))
        "[]"))))

(comp/impl comp/to-str HashMap
  (comp/fn (m _) ()
    (comp/let
      (cnt (comp/count m)
       n (i64/sub cnt 1))
      (comp/if (i64/gt_u cnt 0)
        (comp/for-each m "{" 0 -1
          (comp/fn (kv accum i _) (n)
            (comp/let
              (k (comp/pr-str (comp.LeafNode/key kv))
               accum (comp/concat-str (comp/concat-str accum k) " ")
               v (comp/pr-str (comp.LeafNode/val kv))
               accum (comp/concat-str accum v))
              (comp/if (i64/lt_u i n)
                (comp/concat-str accum " ")
                (comp/concat-str accum "}")))))
        "{}"))))

(comp/impl comp/to-str Function
  (comp/fn (f _) ()
    "#function"))

(comp/impl comp/to-str Seq
  (comp/fn (seq _) ()
    (comp/let (cnt (comp/count seq))
      (comp/if (i64/gt_u cnt 0)
        (comp/let (n (i64/sub cnt 1))
          (comp/for-each seq "(" 0 -1
            (comp/fn (el accum i _) (n)
              (comp/let (accum (comp/concat-str accum (comp/pr-str el)))
                (comp/if (i64/lt_u i n)
                  (comp/concat-str accum " ")
                  (comp/concat-str accum ")"))))))
        "()"))))

(comp/compile)

;; todo: handle splicing-unquote
(comp/impl comp/syntax-quote Seq
  (comp/fn (form _) ()
    (comp/let (cnt (comp/count form))
      (comp/if (i64/gt_u cnt 0)
        (comp/let (accum (comp/array (i64/add cnt 1)))
          (comp/to-seq
            (comp/for-each form
              (comp/array-set accum 0 (comp/symbol "comp" "list")) 0 -1
              (comp/fn (el accum i _) ()
                (comp/let
                  (el (comp/if
                        (comp/if (comp.Seq/instance el)
                          (comp/if (comp/eq (comp/first el) 'comp/unquote)
                            true
                            nil)
                          nil)
                        (comp/nth el 1 nil)
                        (comp/syntax-quote el)))
                  (comp/array-set accum (i64/add i 1) el))))))
       ()))))

(comp/impl comp/syntax-quote Vector
  (comp/fn (vec _) ()
    (comp/list
      (comp/symbol "comp" "to-vec")
      (comp/syntax-quote (comp/to-seq vec)))))

(comp/def* :comp/string-ends-with
  (comp/fn (string substring _) ()
    (comp/string-matches-at string substring
      (i64/sub
        (comp.String/length string)
        (comp.String/length substring)))))

(comp/def* :comp/gensym-counter (comp/atom 0))

;; todo: pass environment as arg
(comp/impl comp/syntax-quote Symbol
  (comp/fn (sym _) ()
    (comp/let
      (ns (comp.Symbol/namespace sym)
       ns (comp/if ns (comp/force-to-string ns) ns)
       nm (comp/force-to-string (comp.Symbol/name sym))
       nm (comp/if ns nm
            (comp/if (comp/string-ends-with nm "#")
              (comp/concat-str
                (comp/concat-str
                  (comp/substring-until nm 0
                    (i64/sub (comp.String/length nm) 1))
                  "__gensym__")
                (comp/to-str (comp/deref comp/gensym-counter)))
              nm)))
      (comp/list (comp/symbol "comp" "symbol") ns nm))))

(comp/def* :comp/special-forms (comp/atom {}))

(comp/impl comp/expand-form Seq
  (comp/fn (form env) ()
    (comp/if (i64/gt_u (comp/count form) 0)
      (comp/let
        (head (comp/first form)
         tail (comp/rest form)
         special
           (comp/if (comp.Symbol/instance head)
             (comp/if (comp/eq head (comp/symbol "comp" "syntax-quote"))
               (comp/let
                 [gensym-num (comp/deref comp/gensym-counter)
                  form (comp/syntax-quote (comp/first tail))]
                 (comp/do
                   (comp/reset! comp/gensym-counter (i64/add gensym-num 1))
                   (comp/call-mtd comp/expand-form form env)))
               (comp/let
                 (head (comp/call-mtd comp/expand-form head env)
                  special (comp/get (comp/deref comp/special-forms) head nil))
                 (comp/if special (special tail env) nil)))
             nil))
        (comp/if special special
          (comp/map!
            (comp/fn (form _) (env)
              (comp/call-mtd comp/expand-form form env))
            form)))
      form)))

(comp/store-alias 'if 'if)
;(comp/store-alias 'do 'do)
;(comp/store-alias 'compile 'compile)
;(comp/store-alias 'store-ns-alias 'store-ns-alias)
;(comp/store-alias 'symbol 'symbol)
;(comp/store-alias 'let 'let)
;(comp/store-alias 'def 'def)

(comp/compile)

(comp/reset! comp/special-forms
  (comp/assoc (comp/deref comp/special-forms) 'defspecial
    (comp/fn (args env _) ()
      (comp/let
        (nm (comp.Symbol/name (comp/first args))
         fn (comp/nth args 1 nil))
        (comp/call-mtd comp/expand-form
         `(comp/do (comp/compile)
            (comp/store-ns-alias (comp/symbol nil ~nm))
            (comp/reset! comp/special-forms
              (comp/assoc
                (comp/deref comp/special-forms)
                (comp/get (comp/deref comp/aliases) (comp/symbol nil ~nm) nil)
                ~fn)))
          env)))))

(comp/compile)

(comp/impl comp/get-scope Symbol
  (comp/fn (sym scope inner-env outer-env _) ()
    (comp/if (comp/get inner-env sym nil)
      scope
      (comp/if (comp/get outer-env sym nil)
        (comp/conj scope sym)
        scope))))

(comp/impl comp/get-scope Seq
  (comp/fn (seq scope inner-env outer-env _) ()
    (comp/for-each seq scope 0 -1
      (comp/fn (x scope i _) (inner-env outer-env)
        (comp/get-scope x scope inner-env outer-env)))))

;; todo: namespace
;; todo: separate params & scope
(defspecial fn
  (comp/fn (args env _) ()
    (comp/let
      (nm (let [nm (comp/first args)]
            (comp/if (comp.Symbol/instance nm) nm nil))
       params (comp/nth args (comp/if nm 1 0) nil)
       params (comp/conj params nm)
       body (comp/nth args (comp/if nm 2 1) nil)
       scope-env
         (comp/for-each params (comp/deref comp/aliases) 0 -1
           (comp/fn (param env i _) ()
             (comp/assoc env param param)))
       scope (comp/get-scope body [] scope-env env)
       config (comp/assoc {} :params params)
       env (comp/for-each scope scope-env 0 -1
             (comp/fn (sym env i _) ()
               (comp/assoc env sym sym))))
      (comp/list 'comp/fn (comp/assoc config :scope scope)
        (comp/call-mtd comp/expand-form body env)))))

(defspecial def
  (comp/fn (args env _) ()
    (comp/let (nm (comp.Symbol/name (comp/first args)))
      (comp/list 'comp/do (comp/list 'comp/compile)
        (comp/list 'comp/store-ns-alias (comp/list 'comp/symbol nil nm))
        (comp/list 'comp/let
          (comp/to-vec
            (comp/list 'full
              (comp/list 'comp/get
                (comp/list 'comp/deref 'comp/aliases)
                (comp/list 'comp/symbol nil nm)
                nil)
              'kw
              (comp/list 'comp/keyword
                (comp/list 'comp.Symbol/namespace 'full)
                (comp/list 'comp.Symbol/name 'full))))
          (comp/list 'comp/def 'kw
            (comp/call-mtd comp/expand-form
              (comp/nth args 1 nil) env)))))))

(comp/pr {:a 1 :b 2})
(comp/pr `x#)
(comp/pr `1)
(comp/pr `a)
(comp/pr `(a))
(comp/pr `(1 (2 3)))
(comp/pr (comp/count "abc"))
(comp/pr (comp/substring "abcd" 1 3))
(comp/pr (comp/index-of-codepoint "abcd" 99))
(comp/pr (comp/hash "comp/fn"))
(comp/pr (comp/eq 1 2))
(comp/pr (comp/eq 3 3))
(comp/pr (comp/concat-str "a" "b"))
(comp/pr [1 2 3])
(comp/pr '(1 2 3))
(comp/pr (comp/map! (comp/fn (x _) () (i64/add x 1)) [4 5 6]))

(comp/impl comp/expand-form Symbol
  (comp/fn (s env) ()
    ;; todo: why inc-refs necessary?
    (comp/let (ns (comp/inc-refs (comp.Symbol/namespace s)))
      (comp/if (comp/eq ns "i64")
        s
        (comp/let (ss (comp/get env s nil))
          (comp/if ss ss
            (comp/let (ss (comp/get (comp/deref comp/aliases) s nil))
              (comp/if ss
                (comp/if (comp/eq ss s)
                  ss
                  (comp/call-mtd comp/expand-form ss env))
                (comp/throw s
                  (comp/concat-str "symbol not found: " (comp/to-str s)))))))))))

(comp/impl comp/expand-form HashMap
  (comp/fn (form env) ()
    (comp/for-each form {} 0 -1
      (comp/fn (kv accum n _) ()
        (comp/list (comp/symbol "comp" "assoc") accum
          (comp.LeafNode/key kv)
          (comp.LeafNode/val kv))))))

(comp/compile)

