export default class Compoted {

    static options = {
        encode: {

            // html
            '>': {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#x27;',
            },

            // attribut booléen sans guillemet
            ' ': {
                '&': '&#38;',
                '<': '&#60;',
                '>': '&#62;',
                '"': '&#x22;',
                "'": '&#x27;',
                '=': '&#61;',
                ' ': '&#160;',
                '%': '&#37;',
                '*': '&#42;',
                '+': '&#43;',
                ',': '&#44;',
                '-': '&#8208;',
                '/': '&#47;',
                ';': '&#59;',
                '^': '&#94;',
                '|': '&#124;',
            },

            // attribut sans guillemet
            '=': {
                '&': '&#38;',
                '<': '&#60;',
                '>': '&#62;',
                '"': '&#x22;',
                "'": '&#x27;',
                '=': '&#61;',
                ' ': '&#160;',
                '%': '&#37;',
                '*': '&#42;',
                '+': '&#43;',
                ',': '&#44;',
                '-': '&#8208;',
                '/': '&#47;',
                ';': '&#59;',
                '^': '&#94;',
                '|': '&#124;',
            },

            // attribut encadré de guillemets doubles
            '"': {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
            },

            // attribut encadré de guillemets simples
            "'": {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                "'": '&#x27;',
            },
        },    
    }

    static functions = {

        // Element avec contenu
        '_': (state, instance, element, slot) => {

            const name = element._
            const isComponent = name[0] === name[0].toUpperCase()
            const componentFound = isComponent && name in state.components
            let tag = `<${name}`

            let closer = '>'
            const attributes = { ...element.__ }
            for (const attribute in attributes) {
                let aa = attributes[attribute]

                // Element booléen
                if (attribute === '/') {
                    closer = '/>'
                    continue
                }

                // Attribut booléen
                if (aa === 1) {
                    tag += ` ${attribute}`
                    continue
                }

                // Quotes la valeur s'il s'agit d'une expression
                let quote = ''
                if (Array.isArray(aa) && aa[0] instanceof Object && 'e' in aa[0] && [`'`, `"`, '?'].includes(aa[0].e)) {
                    quote = aa[0].e
                }

                // S'il s'agit d'un composant
                if (isComponent) {

                    // Transmet les données brutes sans être encodées
                    if (Array.isArray(aa) && aa.length >= 2 && aa[0] instanceof Object && 'e' in aa[0]) {
                        aa = aa[1]
                    }

                    // Supprime les quotes de délimitations si existants
                    if (typeof aa === 'string') {
                        const first = aa.at(0)
                        if ([`'`, `"`].includes(first) && aa.at(-1) === first) {
                            aa = aa.slice(1, -1)
                        }
                    }
                }

                aa = attributes[attribute] = this.nextPair(state, instance, aa)
                if (!isComponent || !componentFound) {
                    const isBooleanAttribut = parseInt(attribute) > 0
                    const isConditionalAttribut = (quote === '?' ? quote = `"` : false)

                    if (isBooleanAttribut) {
                        if (aa) tag += ` ${aa}`
                    }
                    else if (isConditionalAttribut && aa === true) {
                        tag += ` ${attribute}`
                    }
                    else if (!isConditionalAttribut || aa) {
                        tag += ` ${attribute}=${quote}${aa}${quote}`
                    }
                }
            }

            // Construit le slot
            const slotBuilt = slot ? slot.map(pair => this.nextPair(state, instance, pair)) : undefined

            // Transfert les arguments
            if (isComponent) {
                if (componentFound) {
                    const Component = state.components[name]
                    const component = new Component(state, attributes, slotBuilt) 
                    return this.build(state, component, instance)
                }
            }
            
            // Element HTML simple ou composant non trouvé
            tag += closer
            return slot ? [ tag, ...slotBuilt, `</${name}>` ] : tag
        },

        code: (state, instance, code) => {
            try { return code(instance, state) }
            catch (e) {
                console.error(`\x1b[31m
___________________________________________________
BUILD CODE ERROR - ${instance.constructor.name}
\x1b[35m${code.toString()}
\x1b[31m${e.toString()}
___________________________________________________
\x1b[0m`)

            }
        },

        // Expression
        x: (state, instance, _) => this.functions.code(state, instance, _.x),
    
        // Slot
        s: (state, instance, _) => this.functions.code(state, instance, _.s),
    
        // Encode
        e: (state, instance, _, slot) => {
            const next = this.nextPair(state, instance, slot)
            const quote = _.e === '?' ? `'` : _.e
            return next?.toString().split('').map(char => this.options.encode[quote][char] ?? char).join('')
        },

        // if
        if: (state, instance, _, slot) => this.functions.code(state, instance, _.if) ? slot.map(pair => this.nextPair(state, instance, pair)) : '',

        // for..of array
        of: (state, instance, _, slot) => {
            let idx = 0
            const map = []
            const arr = this.functions.code(state, instance, _.of)
            for (const v of arr) {
                instance[_.v] = v
                instance[_.v + '___index'] = idx++
                map.push(slot.map(pair => this.nextPair(state, instance, pair)))
            }
            return map
        },

        // for..in object
        in: (state, instance, _, slot) => {
            let idx = 0
            const map = []
            const obj = this.functions.code(state, instance, _.in)
            for (const k in obj) {
                instance[_.k] = k
                instance[_.v] = obj[k]
                instance[_.v + '___index'] = idx++
                map.push(slot.map(pair => this.nextPair(state, instance, pair)))
            }
            return map
        },

        // for..to
        to: (state, instance, _, slot) => {
            const map = []
            const to = this.functions.code(state, instance, _.to)
            for (let i=_.from ?? 0; i < to; i++) {   
                instance[_.v] = i
                map.push(slot.map(pair => this.nextPair(state, instance, pair)))
            }
            return map
        },

    }

    static buildStyleVars(vars) {
        const block = []
        for (const variable in vars) {
            block.push(`--${variable}: ${vars[variable]};`)
        }
        return block.length ? `\n:root {\n${block.join("\n")}\n}\n` : ''
    }

    static buildScriptVars(vars) {
        const list = []
        for (const variable in vars) {
            list.push(`const ${variable} = ${JSON.stringify(vars[variable])}`)
        }
        return list.length ? `\n${list.join("\n")}\n` : ''
    }


    /**
     * Renvoie le texte correspondant à cet élément
     * @param {any} pair
     * @returns {string}
     */
    static nextPair(state, instance, pair) {
        let fn
        if (typeof pair === 'string') return pair
        if (Array.isArray(pair) && pair[0] instanceof Object) {
            for (fn in pair[0]) break
            if (fn in this.functions) {
                return this.functions[ fn ](state, instance, pair[0], pair[1])
            }
            console.dir({ error: `nextPair() pair function unknown`, fn, pair }, { depth: Infinity } )
        }
        else {
        /*
        if (fn in this.functions) return this.functions[ fn ](instance, pair[0], pair[1])//.toString()
        */
            console.dir({ error: `nextPair() pair format unknown`, pair }, { depth: Infinity } )
        }
        return ''
    }


    static checkFormat(values, instance, caller) {

        for (const value in values) {
            let acceptedType = values[value]
            const optional = acceptedType.at(0) === '*'
            if (!(value in instance) && !optional) {
                throw new Error(`Build error - Missing value « ${value} » on « ${caller?.constructor.name}->${instance.constructor.name} »\n${JSON.stringify(instance)}\n\n`)
            }
            const currentType = typeof instance[value]
            let pass = optional && [null, undefined].includes(instance[value])
            if (!pass) {
                acceptedType = acceptedType.replace('*', '').trim()
                const isList = (acceptedType.at(0) === '[' && acceptedType.at(-1) === ']')
                const acceptedTypes = isList ? acceptedType.replace(' ', '').slice(1, -1).split(',') : [ acceptedType ]
                for (const acceptedType of acceptedTypes) {
                    switch (acceptedType.trim()) {
                        case 'Object':
                            if (currentType === 'object' 
                            && !Array.isArray(instance[value]) 
                            && instance[value] !== null) pass = true
                            break
                        case 'Array': 
                            if (Array.isArray(instance[value])) pass = true
                            break
                        case 'Float':
                        case 'Number':
                            if (Number.isInteger(instance[value])) pass = true
                            if (instance[value] * 1 == instance[value]) {
                                instance[value] *= 1
                                pass = true
                            }
                            break
                        case 'String':
                            if (currentType === 'string') pass = true
                            break
                        case 'Boolean':
                            if (currentType === 'boolean') pass = true
                            break
                        case 'Function':
                            if (currentType === 'function') pass = true
                            break
                    }
                    if (pass) break
                }
            }
            if (!pass) throw new Error(`Build error - value « ${value} » is not « ${acceptedType} » ( ${JSON.stringify(instance[value])} ) on component « ${caller?.constructor.name}->${instance.constructor.name}`)
        }
    }

    /**
     * Gestion des traductions de fonction ( variables à inclure ou conditions d'orthographe et grammaire )
     * 
     * @param {any} _ Variable(s) à utiliser
     * @param {Object} translations Objet contenant les éventuelles conditions et la traduction
     * @returns 
     */
    static i18n(_, translations) {
        let condition

        // Cheche la 1ère condition qui match ( ou « * » en défaut )
        const operators = [ '*', '=', '==', '===', '!=', '!==', '<', '<=', '>', '>='  ]
        for (const cond in translations) {

            for (const op of operators) {
                const idx = cond.indexOf(op)
                if (idx === -1) continue
                const [ name, to ] = cond.split(op)
                const src = name ? _[name] : _
                if ((op === '*')
                || (op === '=' && src == to)
                || (op === '==' && src == to)
                || (op === '===' && src === to)
                || (op === '!=' && src != to)
                || (op === '!==' && src !== to)
                || (op === '>' && src > to)
                || (op === '>=' && src >= to)
                || (op === '<' && src < to)
                || (op === '<=' && src <= to)) {
                    condition = cond
                    break
                }
            }

            if (condition) break
        }

        // Remplace les valeurs ( {0} si aucun nom )
        let translation = translations[condition || '*'] ?? ''
        if (typeof _ === 'object') {
            for (const name in _) translation = translation.replaceAll(`{${name}}`, _[name])
        }
        else translation = translation.replaceAll(`{?}`, _)
        return translation
    }

    /**
     * Construit le composant
     * 
     * @param {any} instance
     * @param {any} pairList Liste de paire [ {obj}, [arr] ], [ { obj}, [arr] ], ...
     * @returns {any}
     */
     static async build(state, instance, caller) {
        const ___ = instance.constructor.___
        const name = instance.constructor.name
        const firstInstance = ___.prepared === 0 ? true : false
        ___.prepared++

        // Vérifie les attributs
        this.checkFormat(___.param, instance, caller)

        // Configure le composant une seule fois si aucune autre instance ne l'a encore fait
        if (firstInstance) {

            // Initialise la liste des composants enfants
            ___.components = {}
            for (const dep in ___.dependencies) {
                ___.components[dep] = state.components[dep]
            }

            // Initialise les traductions par fonction
            ___.i18n = this.i18n
            if (!('scriptLabels' in state)) {
                state.scriptLabels = {}
            }
            for (const l in ___.label[state.locale]) {
                if (___.scriptLabels?.includes(l)) {
                    state.scriptLabels[l] = ___.label[state.locale][l]
                }
            }
            
            // Prépare une fois le composant pour toutes les instances
            if ('prepare' in instance.constructor) {
                await instance.constructor.prepare(state)
            }
        }

        // Initialise le composant en utilisant les attributs transmis lors de l'instanciation
        if ('init' in instance) await instance.init(state, instance)

        // Vérifie les variables générées
        this.checkFormat(___.var, instance, caller)

        // Convertit les variables de styles
        if (firstInstance) {
            if ('styleVars' in ___.setup && ___.setup.styleVars instanceof Object) {
                ___.setup.styleVars = this.buildStyleVars(___.setup.styleVars) 
                ___.styles.unshift(___.setup.styleVars)
            }

            // Convertit les variables de script
            if ('scriptVars' in ___.setup && ___.setup.scriptVars instanceof Object) {
                ___.setup.scriptVars = this.buildScriptVars(___.setup.scriptVars) 
                ___.scripts.unshift(___.setup.scriptVars)
            }
            const cdata = '/*<![CDATA[*/'
            if (___.scripts.length && ___.scripts[0] !== cdata) {
                ___.scripts.unshift(cdata)
                ___.scripts.push('/*]]>*/')
            }
        }

        // Convertit chaque « paire »
        return (await Promise.all(
            ___.template.map(pair => this.nextPair(state, instance, pair))
            .flat(Infinity)
            .map(async x => x instanceof Promise ? await Promise.resolve(x) : x)
        )).join('')
    }

    static async loadDependencies(Component, loaded, nested=false) {
        for (let dep in Component.___.dependencies) {
            if (dep in loaded) continue
            loaded[dep] = (await import(Component.___.dependencies[dep])).default
            if (nested) await this.loadDependencies(loaded[dep], loaded, true)
        }
    }
}
