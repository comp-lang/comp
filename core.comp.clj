;; todo:
;; check vector/map for nested runtime ops, change to forms
;; comment in list before close parens adds extra argument
;; compile after def?
;; replace comp/call-mtd with general form to limit args

(comp/defmethod :comp/to-str 2 nil)

(comp/defmethod :comp/namespace 2 nil)

(comp/defmethod :comp/name 2 nil)

(comp/defmethod :comp/to-sym 2 nil)

(comp/defmethod :comp/syntax-quote 2
  (comp/fn (x _) () x))

(comp/defmethod :comp/get-scope 5
  (comp/fn (x scope inner-env outer-env _) ()
    scope))

(comp/def :comp/curr-ns (comp/atom (comp/list "comp.core")))

(comp/def :comp/aliases (comp/atom {}))

;; compile
(comp/compile)

(comp/defmethod :comp/pr-str 2
  (comp/fn (x _) ()
    (comp/call-mtd comp/to-str x comp/to-str)))

(comp/impl comp/namespace comp.Symbol
  (comp/fn (sym _) ()
    (comp/let (ns (comp.Symbol/namespace sym))
      (comp/if ns
        (comp/force-to-string
          (comp/inc-refs-if-external sym ns))
        ns))))

(comp/impl comp/namespace comp.Keyword
  (comp/fn (kw _) ()
    (comp/let (ns (comp.Keyword/namespace kw))
      (comp/if ns
        (comp/force-to-string
          (comp/inc-refs-if-external kw ns))
        ns))))

(comp/impl comp/name comp.Symbol
  (comp/fn (sym _) ()
    (comp/force-to-string
      (comp/inc-refs-if-external sym
        (comp.Symbol/name sym)))))

(comp/impl comp/name comp.Keyword
  (comp/fn (kw _) ()
    (comp/force-to-string
      (comp/inc-refs-if-external kw
        (comp.Keyword/name kw)))))

(comp/def :comp/key
  (comp/fn (leaf _) ()
    (comp/inc-refs-if-external leaf
      (comp.LeafNode/key leaf))))

(comp/def :comp/val
  (comp/fn (leaf _) ()
    (comp/inc-refs-if-external leaf
      (comp.LeafNode/val leaf))))

(comp/def :comp/store-alias
  (comp/fn (alias sym _) ()
    (comp/reset! comp/aliases
      (comp/assoc (comp/deref comp/aliases)
        (comp/to-sym alias)
        (comp/to-sym sym)))))

;; compile
(comp/compile)

(comp/impl comp/to-sym comp.Symbol (comp/fn (s _) () s))

(comp/impl comp/to-sym comp.Keyword
  (comp/fn (kw _) ()
    (comp/symbol
      (comp/namespace kw)
      (comp/name kw))))

(comp/def :comp/store-ns-alias
  (comp/fn (alias _) ()
    (comp/let
      (ns (comp/first (comp/deref comp/curr-ns))
       full (comp/symbol ns (comp/name alias)))
      (comp/do
        (comp/store-alias alias full)
        (comp/store-alias full full)))))

(comp/def :comp/def*
  (comp/fn (nm val _) ()
    (comp/do
      (comp/def nm val)
      (comp/store-alias nm nm)
      (comp/store-alias
        (comp/symbol nil (comp/name nm))
        nm))))

;; compile
(comp/compile)

(comp/def* :comp/gensym-counter (comp/atom 0))

(comp/def* :comp/pr
  (comp/fn (x _) ()
    (js/console.log (comp/pr-str x))))

(comp/def* :comp/string-ends-with
  (comp/fn (string substring _) ()
    (comp/string-matches-at string substring
      (i64/sub
        (comp/count string)
        (comp/count substring)))))

(comp/def* :comp/special-forms (comp/atom {}))

(comp/def* :comp/map!
  (comp/fn (f coll _) ()
    (comp/to-seq
      (comp/for-each coll (comp/array (comp/count coll)) 0 -1
        (comp/fn (el arr i _) (f)
          (comp/array-set arr i (f el)))))))

;; compile
(comp/compile)

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

;; todo: escape double quotes
(comp/impl comp/pr-str comp.String
  (comp/fn (s _) ()
    (comp/concat-str "\""
      (comp/concat-str s "\""))))

(comp/impl comp/to-str comp.Nil (comp/fn (_ _) () "nil"))
(comp/impl comp/to-str comp.True (comp/fn (_ _) () "true"))
(comp/impl comp/to-str comp.False (comp/fn (_ _) () "false"))
(comp/impl comp/to-str comp.String (comp/fn (s _) () s))

(comp/impl comp/to-str comp.Int
  (comp/fn (i _) ()
    (comp/i64->string i)))

(comp/impl comp/to-str comp.Symbol
  (comp/fn (sym _) ()
    (comp/let
      (ns (comp/namespace sym)
       nm (comp/name sym))
      (comp/if ns
        (comp/concat-str ns
          (comp/concat-str "/" nm))
        nm))))

(comp/impl comp/to-str comp.Keyword
  (comp/fn (sym _) ()
    (comp/let
      (ns (comp/namespace sym)
       nm (comp/name sym))
      (comp/concat-str ":"
        (comp/if ns
          (comp/concat-str ns
            (comp/concat-str "/" nm))
          nm)))))

(comp/impl comp/to-str comp.Vector
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

(comp/impl comp/to-str comp.HashMap
  (comp/fn (m _) ()
    (comp/let
      (cnt (comp/count m)
       n (i64/sub cnt 1))
      (comp/if (i64/gt_u cnt 0)
        (comp/for-each m "{" 0 -1
          (comp/fn (kv accum i _) (n)
            (comp/let
              (k (comp/pr-str (comp/key kv))
               accum (comp/concat-str (comp/concat-str accum k) " ")
               v (comp/pr-str (comp/val kv))
               accum (comp/concat-str accum v))
              (comp/if (i64/lt_u i n)
                (comp/concat-str accum " ")
                (comp/concat-str accum "}")))))
        "{}"))))

(comp/impl comp/to-str comp.Function
  (comp/fn (f _) ()
    "#function"))

(comp/impl comp/to-str comp.Seq
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

;(comp/compile)

;; todo: handle splicing-unquote
(comp/impl comp/syntax-quote comp.Seq
  (comp/fn (form _) ()
    (comp/let (cnt (comp/count form))
      (comp/if (i64/gt_u cnt 0)
        (comp/cons 'comp/list
          (comp/map!
            (comp/fn (el _) ()
              (comp/if
                (comp/if (comp.Seq/instance el)
                  (comp/if (comp/eq (comp/first el) 'comp/unquote)
                    true
                    nil)
                  nil)
                (comp/nth el 1 nil)
                (comp/syntax-quote el)))
            form))
       ()))))

(comp/impl comp/syntax-quote comp.Vector
  (comp/fn (vec _) ()
    (comp/list 'comp/to-vec
      (comp/syntax-quote (comp/to-seq vec)))))

;; todo: pass environment as arg
(comp/impl comp/syntax-quote comp.Symbol
  (comp/fn (sym _) ()
    (comp/let
      (ns (comp/namespace sym)
       nm (comp/force-to-string (comp/name sym))
       gensym (comp/string-ends-with nm "#")
       nm (comp/if ns nm
            (comp/if gensym
              (comp/concat-str
                (comp/concat-str
                  (comp/substring-until nm 0
                    (i64/sub (comp/count nm) 1))
                  "__gensym__")
                (comp/to-str (comp/deref comp/gensym-counter)))
              nm))
       ns (comp/if ns
            (comp/force-to-string ns)
            (comp/if gensym nil
              (comp/first (comp/deref comp/curr-ns)))))
      (comp/list 'comp/symbol ns nm))))

(comp/impl comp/expand-form comp.Seq
  (comp/fn (form env) ()
    (comp/if (i64/gt_u (comp/count form) 0)
      (comp/let
        (head (comp/first form)
         special
           (comp/if (comp.Symbol/instance head)
             (comp/if (comp/eq head 'comp/syntax-quote)
               (comp/let
                 [gensym-num (comp/deref comp/gensym-counter)
                  form (comp/syntax-quote (comp/nth form 1 nil))]
                 (comp/do
                   (comp/reset! comp/gensym-counter (i64/add gensym-num 1))
                   (comp/call-mtd comp/expand-form form env)))
               (comp/let
                 (head (comp/call-mtd comp/expand-form head env)
                  special (comp/get (comp/deref comp/special-forms) head nil))
                 (comp/if special (special form env) nil)))
             nil))
        (comp/if special special
          (comp/map!
            (comp/fn (form _) (env)
              (comp/call-mtd comp/expand-form form env))
            form)))
      form)))

(comp/store-alias 'if 'comp/if)
(comp/store-alias 'comp/if 'comp/if)
;;(comp/store-alias 'do 'do)
;;(comp/store-alias 'compile 'compile)
;;(comp/store-alias 'store-ns-alias 'store-ns-alias)
;;(comp/store-alias 'symbol 'symbol)
;;(comp/store-alias 'let 'let)
;;(comp/store-alias 'def 'def)

(comp/compile)

(comp/reset! comp/special-forms
  (comp/assoc (comp/deref comp/special-forms) 'defspecial
    (comp/fn (form env _) ()
      (comp/let
        (nm (comp/nth form 1 nil)
         fn (comp/nth form 2 nil))
        (comp/call-mtd comp/expand-form
         `(comp/do (comp/compile)
            (comp/store-ns-alias '~nm)
            (comp/reset! comp/special-forms
              (comp/assoc
                (comp/deref comp/special-forms)
                (comp/get (comp/deref comp/aliases) '~nm nil)
                ~fn)))
          env)))))

(comp/compile)

(comp/impl comp/get-scope comp.Symbol
  (comp/fn (sym scope inner-env outer-env _) ()
    (comp/if (comp/get inner-env sym nil)
      scope
      (comp/if (comp/get outer-env sym nil)
        (comp/conj scope sym)
        scope))))

(comp/impl comp/get-scope comp.Seq
  (comp/fn (seq scope inner-env outer-env _) ()
    (comp/for-each seq scope 0 -1
      (comp/fn (x scope i _) (inner-env outer-env)
        (comp/get-scope x scope inner-env outer-env)))))

(comp/def* :comp/is-wasm-num
  (comp/fn (form _) ()
    (comp/if (comp.Seq/instance form)
      (comp/let (head (comp/first form))
        (comp/if (comp.Symbol/instance head)
          (comp/let (ns (comp/namespace head))
            (comp/if (comp/eq ns "i64")
              true
              (comp/eq ns "f64")))
          nil))
      nil)))

(comp/compile)

(comp/def* :comp/form-to-bool
  (comp/fn (form _) ()
    (comp/if (comp/is-wasm-num form)
      form
     `(comp/let (form# ~form)
        (comp/if (comp/eq form# false) nil form#)))))

(comp/compile)

(defspecial if
  (comp/fn (form env _) ()
    (comp/let
      (cnd (comp/form-to-bool (comp/nth form 1 nil))
       if-true (comp/nth form 2 nil)
       if-false (comp/nth form 3 nil))
     `(comp/if ~(comp/call-mtd comp/expand-form cnd env)
       ~(comp/call-mtd comp/expand-form if-true env)
       ~(comp/call-mtd comp/expand-form if-false env)))))

(comp/compile)

(defspecial let
  (comp/fn (form env _) ()
    (comp/let
      (bdgs (comp/nth form 1 nil)
       bdgs-out (comp/array (comp/count bdgs))
       body (comp/array-set
              (comp/array
                (i64/sub (comp/count form) 1))
              0 'comp/do)
       env (comp/for-each bdgs env 0 -1
             (comp/fn (bdg env i _) (bdgs-out)
               (comp/if (i64/eqz (i64/rem_u i 2))
                 (comp/do
                   (comp/array-set bdgs-out i bdg)
                   (comp/assoc env bdg bdg))
                 (comp/do
                   (comp/array-set bdgs-out i
                     (comp/call-mtd comp/expand-form bdg env))
                   env)))))
      (comp/do
        (comp/for-each form body 2 -1
          (comp/fn (form accum i _) (env)
            (comp/array-set accum (i64/sub i 1)
              (comp/call-mtd comp/expand-form form env))))
       `(comp/let
         ~(comp/to-seq bdgs-out)
         ~(comp/to-seq body))))))

(defspecial fn
  (comp/fn (form env _) ()
    (comp/let
      (nm (comp/let (nm (comp/nth form 1 nil))
            (comp/if (comp.Symbol/instance nm) nm nil))
       params (comp/nth form (comp/if nm 2 1) nil)
       params (comp/to-seq (comp/conj params nm))
       body (comp/nth form (comp/if nm 3 2) nil)
       scope-env
         (comp/for-each params {} 0 -1
           (comp/fn (param env i _) ()
             (comp/assoc env param param)))
       scope (comp/get-scope body [] scope-env env)
       env (comp/for-each scope scope-env 0 -1
             (comp/fn (sym env i _) ()
               (comp/assoc env sym sym))))
     `(comp/fn ~params ~(comp/to-seq scope)
       ~(comp/call-mtd comp/expand-form body env)))))

(defspecial def
  (comp/fn (form env _) ()
    (comp/let (nm (comp/nth form 1 nil))
     `(comp/do (comp/compile)
        (comp/store-ns-alias '~nm)
        (comp/let
          (full# (comp/get (comp/deref comp/aliases) '~nm nil)
           kw# (comp/keyword (comp/namespace full#) (comp/name full#) nil))
          (comp/def kw#
           ~(comp/call-mtd comp/expand-form
              (comp/nth form 2 nil) env)))))))

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
(comp/pr (comp/cons 1 ()))
(comp/pr (comp/cons 1 (comp/list 2 3 4)))
(comp/pr (comp/map! (comp/fn (x _) () (i64/add x 1)) [4 5 6]))

(comp/impl comp/expand-form comp.Symbol
  (comp/fn (s env) ()
    (comp/let (ns (comp/namespace s))
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

(comp/impl comp/expand-form comp.HashMap
  (comp/fn (form env) ()
    (comp/for-each form {} 0 -1
      (comp/fn (kv accum n _) ()
       `(comp/assoc ~accum
         ~(comp/key kv)
         ~(comp/val kv))))))

(comp/compile)

