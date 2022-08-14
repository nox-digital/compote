#! /usr/bin/env node

import fsSync from 'fs'
import fs from 'fs/promises'

import { inspect } from 'util'
import path from 'path'
import { fileURLToPath } from 'url'

const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom')
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const cwd = process.cwd()
const app = {
    devMode: false,
}


let http, https, Path


let compoteVersion
const defaultOptions = {
    syntax: {

        // Trouver une expression
        opener:     '{',                // ma {variable}
        closer:     '}',                

        // Comment gérer l'expression
        bypass:     '=',                // <p>hello {=world}</p> => <p>hello {world}<p>
        unprotected:"*",                // <p>{*markdownToHTML}</p> => <p><h1>C'est "OK"</h1></p> 

        // Injection du slot
        slot:       '…',                // <MonComposant>le slot ici {…MonComposant}</MonComposant>
    },
    encode: {
        auto: true,
    },
    attributes: {
        addMissingQuotes: "'",
    },
    noGap: true,
    server: {
        port: process.env.PORT ?? 8080,
        paths: {
            cache: './.compote/cache',
            public: './public',
        },
        routes: [],
    }
}
const compiled = {}
const code = {}
const dependencies = {}
const routes = {}
const forStack = []
const config = {}

const emptyElements = [ 'img', 'input', 'br', 'meta', 'link', 'source', 'base', 'area', 'wbr', 'hr', 'col', 'embed', 'param', 'track', ]

class Expression {
    constructor(x, extraVars) { this.x = x; this.extraVars = extraVars || [] }
    [customInspectSymbol](depth, inspectOptions, inspect) {
        const vars = []
        const x = this.x.trim()
        const isInterpolation = x[0] === '`'
        const locale = Object.keys(compiled.label)[0]
        for (const list of [ Object.keys(compiled.param), Object.keys(compiled.var), Object.keys(compiled.data), this.extraVars, Object.keys(compiled.label[locale] ?? {}) ]) {
            for (const k of list) {
                if (vars.includes(k)) continue
                let idx = -1
                let add = false
                while ((idx = x.indexOf(k, idx + 1)) > -1) {
                    if (idx === -1) break
                    if (idx + k.length < x.length) {
                        const nextCharacter = x.at(idx + k.length)
                        if (nextCharacter.toLowerCase() !== nextCharacter.toUpperCase()) continue
                    }
                    if (idx > 0) {
                        const previousCharacter = x.at(idx - 1)
                        if (['.', '_', '$', '"', "'", '`'].includes(previousCharacter)) continue
                        if (previousCharacter.toLowerCase() !== previousCharacter.toUpperCase()) continue
                    }
                    add = true
                    break
                }
                if (add) vars.push(k)
            }
        }
        const with$ = (x.indexOf('$.') > -1 || x.indexOf('$[') > -1) ? ', $' : ''
        if (!vars.length) return `(_${with$}) => ${x}`
        if (vars.length === 1 && x.startsWith(vars[0])) {
            if (vars[0].length === x.length || ['.', '['].includes(x.at(vars[0].length))) {
                return `(_${with$}) => _.${x}`
            }
        } 
        return `(_${with$}) => { const {${vars.join(',')}} = _; return ${x} }`
    }
}
class Slot {
    constructor(s) { this.s = s }
    [customInspectSymbol](depth, inspectOptions, inspect) {
        return `(_) => _['…${this.s}']`
    }
}


const version = () => {
    if (compoteVersion) return compoteVersion

    const content = fsSync.readFileSync(new URL(`${__dirname}/package.json`, import.meta.url), { encoding: 'utf-8'})
    let json
    try {
        json = JSON.parse(content)
    }
    catch (e) {
        console.error(`can't parse the compote package.json file`)
    }
    compoteVersion = json?.version ?? '?'
    return compoteVersion
}

const configFile = () => {
    if (Object.keys(config).length) return
    let content = null
    try {
        content = fsSync.readFileSync(new URL(`${cwd}/compote.json`, import.meta.url), { encoding: 'utf-8'})
    }
    catch (e) { return false }
    
    if (content === null) return
        

    try {
        const conf = JSON.parse(content)
        if (conf) Object.assign(config, conf)
        for (const r of conf.routes) {
            if (typeof r.match === 'string') r.match = new RegExp(r.match)
        }
    }
    catch (e) {
        console.error(`compote.json format invalid`)
    }
    return
}

function exit(error, details, code = 1) {
    console.dir({ error, details }, { depth: Infinity})
    if (app.devMode) {
        console.log('________________________________________')
        return
    }
    process.exit(code)
}

const splitURL = (u) => {
    const url = u.startsWith('http') ? url : `http://127.0.0.1${u}`
    const querymark = url.indexOf('?')
    const query = querymark > -1 ? url.substring(querymark) : ''
    const hostmark = url.indexOf('/') + 2
    const pathmark = url.indexOf('/', hostmark)
    const host = url.substring(hostmark, pathmark)
    const fullpath = querymark > -1 ? url.substring(pathmark, querymark) : url.substring(pathmark)
    const path = fullpath.substring(fullpath.at(0) === '/' ? 1 : 0, fullpath.at(-1) === '/' ? -1 : fullpath.length) 
    const lastSlash = path.lastIndexOf('/')
    const file = lastSlash === -1 ? path : path.slice(lastSlash + 1)
    const paths = file === path ? path.split('/') : path.slice(0, lastSlash).split('/')
    return { url, host, fullpath, path, query, file, paths }
}

const router = (url) => {
    const u = splitURL(url)
    const args = {}

    for (const r of defaultOptions.server.routes) {
        if (Number.isInteger(r.match)) continue
        const match = u.path.match(r.match)
        if (!match) continue
        if (r.rewrite) {
            return { ...u, rewrited: r.rewrite(match, u.path), cache: r.cache }
        }
        if (r.args?.length) {
            r.args.map((key, i) => args[key] = match[i + 1])
            // console.log({ args, r })
        }
        return { ...u, ...r, args }
    }

    return { ...u, match: false, page: '' }
}


async function server(request, response) {

    
    console.log('HTTP request ', request.url)
    const url = request.url.at(-1) === '/' ? `${request.url}index.html` : request.url
    let filePath

    // Route demandée
    let ssr
    if (app.devMode) {
        ssr = (route) => {
            // Vérifie que le chemin indiqué par la route existe puis l'importe
            const compiledFilePath = addPaths(config.paths?.compiled, `${route.page}.tpl.mjs`)
            if (!fsSync.existsSync(compiledFilePath)) {
                console.error(`Component « ${route.page} » not found`, { url, route, compiledFilePath })
                response.writeHead(418)
                return response.end(``)
            }
    
            try { 
                build(compiledFilePath, route.args, response)
            }
            catch (e) {            
                console.error('\x1b[35m%s\x1b[0m', `BUILD ERROR:\n${e.toString()}`)
                response.writeHead(500)
                return response.end(``)
            }
        }
    
    
        const route = router(url)
        if (route.rewrited) {
            filePath = `${defaultOptions.server.paths.cache}/${route.path}`

            // S'il n'existe pas encore en cache
            if (!route.cache || !fsSync.existsSync(filePath)) {

                console.log('DOWNLOAD', filePath)
                // Créé les répertoires intérmédiaires
                await fs.mkdir(`${defaultOptions.server.paths.cache}/${route.paths.join('/')}`, { recursive: true })

                // Télécharge le fichier
            const file = fsSync.createWriteStream(filePath)
            const dl = https.get(route.rewrited, res => res.pipe(file))
            await Promise.resolve(dl)
                    .catch(err => {
                        console.log({ DOWNLOAD_ERROR: err })
                        fsSync.unlink(filePath)
                    })
            await new Promise(resolve => setTimeout(resolve, 200))
            }
        }
        else if (route.page) {
            return ssr(route)
        }

    }


    // Aucune route ne correspond, on renvoie le fichier demandé du dossier public
    const staticPath = app.devMode  ? (process.env.PUBLIC_STATIC || defaultOptions.server.paths.public)
                                : `${config.paths.dist}/${process.env.PUBLIC_DOMAIN}/public`
    filePath = filePath ? filePath : `${staticPath}${url}`
    const extname = String(Path.extname(filePath)).toLowerCase()
    if (!extname) filePath += '/index.html'
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.wav': 'audio/wav',
        '.mp4': 'video/mp4',
        '.woff': 'application/font-woff',
        '.ttf': 'application/font-ttf',
        '.eot': 'application/vnd.ms-fontobject',
        '.otf': 'application/font-otf',
        '.wasm': 'application/wasm'
    }

    const contentType = mimeTypes[extname || '.html'] || 'application/octet-stream'
    fsSync.readFile(filePath, function(error, content) {
        if (error) {
            if (error.code == 'ENOENT') {
                response.writeHead(404);
                const custom404 = defaultOptions.server.routes.find(r => r.match === 404)
                if (!custom404) return response.end(`Page Not Found\n`);
                if (ssr) return ssr(custom404)
            }
            else {
                response.writeHead(500);
                return response.end(`error: ${error.code} ..\n`);
            }
        }
        else {
            response.writeHead(200, { 'Content-Type': contentType })
            return response.end(content, 'utf-8')
        }
    })

}

const envFile = async (filename) => {
    const env = await fs.readFile(filename, { encoding: 'utf-8' })
        .catch(e => exit(`\x1b[31mEnvironment file « ${filename} » not found\x1b[0m`))
    
    const lines = env.trim().split("\n")
    for (const l of lines) {
       const line = l.trim()
       if (!line.length || line[0] === '#') continue
       const equals = line.indexOf('=')
       if (equals < 1) { 
           console.error(`Environment file format invalid`, { line })
           continue
       }
       const key = line.slice(0, equals).trim()
       const value = line.slice(equals + 1)
       process.env[key] = value
    }
}

const addPaths = (...paths) => {
    let all = []
    for (let path of paths) {

        // Convert next paths starts
        if (all.length) {
            if (path.startsWith('./')) path = path.slice(2)
            else if (path.at(0) === '/') path = path.slice(1)
        }

        // Missing first path fallback
        else if (!path) path = './'

        // Trailing slash
        if (path.at(-1) === '/') path = path.slice(0, -1)
        all.push(path)
    }
    return all.join('/')
}


async function build(compiledFilePath, attributes, response) {

    const { Worker, MessageChannel, MessagePort, isMainThread, parentPort } = (await import('worker_threads'))

    if (process.env.ENV) {
        await envFile(process.env.ENV)
        delete process.env.ENV
    }

    let compiledFullPath = addPaths(cwd, compiledFilePath)
    const workerCode = `
        const worker = async () => {
            const [ , , component, attributesJSON ] = process.argv
            const attributes = JSON.parse(attributesJSON)
            const Compote = (await import('${__dirname}/Compote.mjs')).default
            const RequestedComponent = (await import(component)).default
            const {parentPort, workerData} = (await import('worker_threads'))

            const env = {}
            Object.keys(process.env).filter(k => k.startsWith('PUBLIC_')).map(k => env[k] = process.env[k])
            const state = { env, locale: env.PUBLIC_LANG || 'fr', components: {} }

            state.components[RequestedComponent.name] = RequestedComponent
            await Compote.loadDependencies(RequestedComponent, state.components, true, '${compiledFullPath}')
            const requestedComponent = new RequestedComponent(Compote, state, attributes)        
            output = await Compote.build(state, requestedComponent, undefined, true)
            parentPort.postMessage(output)
        }
        worker()
    `
    const compote = new Worker(workerCode, { eval: true, argv: [ compiledFilePath, JSON.stringify(attributes) ] })
    compote.once('message', content => {
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end(content, 'utf-8')
    })
    compote.once('error', content => {
        console.error(`Build error`, content)
        response.writeHead(500, { 'Content-Type': 'text/html' })
        response.end('', 'utf-8')
    })
}

const isFile = (path) => {
    if (path.at(-1) === '/') return false
    return (path.startsWith('./') ? path.slice(2) : path).lastIndexOf('.') > -1
}

async function initProject() {
    console.log('\nInitialize your project...\n')
    const configFile = 'compote.json'
    const exists = await fs.stat(configFile)
        .catch((e) => false)
    if (exists) {
        console.error(`a compote.json file already exists!`)
        process.exit(1)
    }

    const defaultConfig = {
        "paths": {
            "src": "./src/components",
            "compiled": "./compote/compiled",
            "dist": "./dist"	
        },
        "server": {
            "paths": {
                "public": "./public",
                "cache": "./compote/cache"
            }
        },
        "routes": [
            { "match": "^index\\.html$", "page": "HomePage" },
            { "match": 404, "page": "NotFoundPage", "args": [ "path", "query" ] }
        ]        
    }
    const defaultConfigString = JSON.stringify(defaultConfig, undefined, "\t")
    const paths = Object.assign(defaultConfig.paths, defaultConfig.server.paths)
    for (const p in paths) {
        console.log(`create directory ${p} => ${paths[p]}`)
        await fs.mkdir(paths[p], { recursive: true })
    }

    const ignore = [
        '.compose/',
        'dist/',
    ]
    console.log(`\nIgnore theses files in your distributed version control (eg: gitignore) file:\n${ignore.join("\n")}`)

    console.log(`\n\nCreating compose.json config file...`)
    await fs.writeFile(configFile, defaultConfigString, { encoding: 'utf-8' })
        .catch(e => console.error(`can't write ${configFile} file`))

    console.log(`-------------------------------------------------------`)
    console.dir(defaultConfig, { depth: Infinity })
    console.log(`-------------------------------------------------------`)
    console.log(`\n\n Start by running: npx compote --dev    ( Details: npx compote --help )`)

    process.exit(0)
}

async function compote(args=[]) {

    const startTime = new Date()
    const argsWithoutOptions = args.filter(a => !a.startsWith('--'))
    const options = args.filter(a => a.startsWith('--'))
    

    // Initialisation
    compiled.param = {}
    compiled.var = {}
    compiled.data = {}
    compiled.label = {}
    compiled.setup = { hoist: {} }
    compiled.template = []
    compiled.style = ''
    compiled.script = ''
    compiled.scriptLabels = []
    for (const k in code) delete code[k]
    for (const k in dependencies) delete dependencies[k]
    for (const k in routes) delete routes[k]
    forStack.length = 0
    
    let srcPath, compiledPath, distPath, json
    let required = {}
    let errorMessage 

    if (options.includes('--init')) {
        return await initProject()
    }


    if (options.includes('--dist')) {
        [ srcPath, compiledPath, distPath ] = argsWithoutOptions
        required = { srcPath, compiledPath, distPath }
        errorMessage = `missing path parameter\nnpx compote --dist <src path> <compiled path> <build path>`
    }
    else if (options.includes('--build')) {
        [ compiledPath, distPath, json ] = argsWithoutOptions       
        required = { compiledPath, distPath }
        errorMessage = `missing path parameter\nnpx compote --build <compiled path> <build path> [json]`
    } 
    else if (options.includes('--build-pages')) {
        [ compiledPath, distPath ] = argsWithoutOptions
        required = { compiledPath, distPath }
        errorMessage = `missing path parameter\nnpx compote --build-pages <compiled path> <build path>`
    }
    else if (options.includes('--compile') || options.includes('--watch')) {
        [ srcPath, compiledPath ] = argsWithoutOptions
        required = { srcPath, compiledPath }
        errorMessage = `missing path parameter\nnpx compote --compile <src path> <compiled path>`
    }
    else if (options.includes('--dev')) {
        [ srcPath, compiledPath ] = argsWithoutOptions
        required = { srcPath, compiledPath }
        errorMessage = `missing path parameter\nnpx compote --dev <src path> <compiled path>`
    }

    if (('srcPath' in required && !required.srcPath)
    || ('compiledPath' in required && !required.compiledPath)
    || ('distPath' in required && !required.distPath)) {
        if (config.paths.src) srcPath = config.paths.src
        if (config.paths.compiled) compiledPath = config.paths.compiled
        if (config.paths.dist) distPath = config.paths.dist
    
        if (('srcPath' in required && !srcPath)
        || ('compiledPath' in required && !compiledPath)
        || ('distPath' in required && !distPath)) {
            console.error(errorMessage, Object.values(required))
            process.exit(1)
        }
    }


    if (!args.length || options.includes('--help')) {

        version()
        console.log(`

COMPOTE version ${compoteVersion}


Compilation:
------------

    By component:
    npx compote --compile ./src/Component.html ./compiled/ 

    By folder:
    npx compote --compile ./src/ ./compiled/

    Compile folder and watch changes to auto-compilation: 
    npx compote --watch ./src/ ./compiled/


Build:
------

    By file with optional JSON parameters:
    npx compote --build ./compiled/Component.tpl.mjs ./build/index.html {json}

    Build all pages, based on .env file or folder:
    npx compote --build-pages ./compiled/ ./build/


Distribution:
-------------

    Compilation and build all pages
    npx compote --dist ./src/ ./compiled/ ./build/


Developement:
------------
    Development web server with auto-compilation and building based on .env file or folder:
    npx compote --dev ./src/ ./compiled/
        `)
        process.exit(1)
    }



    // Auto-compilation
    if (options.includes('--watch') || options.includes('--dev')) {

        // Compile l'ensemble des components
        if (options.includes('--dev') && !options.includes('--bypass-compile')) {
            await compote([ '--compile', srcPath, compiledPath ])
        }

        // Charge les dépendences
        if (Array.isArray(config.routes)) defaultOptions.server.routes = config.routes
        else console.warn(`\x1b[34mRoutes file ${routesFile} not found, switch to auto-detect mode\x1b[0m `)

        const dedup = {}

        const onchange = (dir, eventType, file) => {
            if (eventType !== 'change') return
            const ext = file.slice(file.indexOf('.'))
            if (!['.html', '.css', '.js', '.mjs'].includes(ext)) return

            const name = file.split('.')[0]
            const filepath = `${dir}/${name}.html`
            clearTimeout(dedup[filepath])
            dedup[filepath] = setTimeout(() => { 
                console.log(`\ncomponent ${name}${ext} ${eventType}`)
                // const outfile = addPaths(compiledPath, `${name}.tpl.mjs`)
                compote([ '--compile', filepath, compiledPath ]) //filepath.replace(paths.templates, paths.components).replace('.html', '.tpl.mjs') ])
            })
        }

        const directories = await directoryTree(srcPath.at(-1) === '/' ? srcPath.slice(0, -1) : srcPath)
        for (const dir of directories) {
            fsSync.watch(dir, (ev, file) => onchange(dir, ev, file))
        }
        console.log('watching changes in directories:', directories)
    }


    // Build environment
    if (options.includes('--build') 
        || options.includes('--build-pages')
        || options.includes('--dist')
        || options.includes('--dev')) {
            await envFile('.env')
    }


    // Construction d'un composant compilé à un fichier .html
    if (options.includes('--build')) {
        if (!compiledPath) exit(`Missing compiled component source to build`)
        if (!distPath || ['"', "'", '{'].includes(distPath.at(0))) exit(`Missing HTML file destination to build`)
        console.log(`construction du composant ${compiledPath} => ${distPath}`)
        let attributes = {}
        try { 
            if (json) attributes = JSON.parse(json) 
        }
        catch (e) { 
            exit(`Error when parsing JSON parameters: ${e} « ${json} »`) 
        }
        const html = await build(compiledPath, attributes, {
            writeHead: (code, message) => console.dir({code, message}),
            response: (response) => console.log({response}),
            end: (content, encoding) => fs.writeFile(distPath, content, { encoding })
                                            .catch(e => console.log)
            })
        // console.log(html)
        return
    }

    // Construction de toutes les pages
    if ((options.includes('--build-pages') || options.includes('--dist'))
    && !options.includes('--bypass-build')) {

        // Compile l'ensemble des components
        if (options.includes('--dist') && !options.includes('--bypass-compile')) {
            await compote([ '--compile', srcPath, compiledPath ])
        }



        // Recherche les composants terminant par « Page.tpl.mjs »
        const pages = (await fs.readdir(compiledPath))
            .filter(f => f.indexOf('Page.tpl.mjs') > 0)

        const env = {}
        Object.keys(process.env).filter(k => k.startsWith('PUBLIC_')).map(k => env[k] = process.env[k])
        const Compote = (await import(`${__dirname}/Compote.mjs`)).default
        const state = { env, locale: env.PUBLIC_LANG || 'fr', components: {}, allComponents: {} }
        
        const mkdirCreated = []
        let output = ''
        let nbCharacters = 0
        let nbPages = 0
        let compiledFullPath = addPaths(cwd, compiledPath)
        if (compiledFullPath.at(-1) === '/') compiledFullPath = compiledFullPath.slice(0, -1)
        for (const page of pages) {
            const Component = (await import(`${compiledFullPath}/${page}`)).default
            state.allComponents[Component.name] = Component
            const routes = await Component.routes()
            state.components = await Compote.loadDependencies(Component, state.allComponents, true, compiledFullPath)
            const prefix = `${distPath}/${env.PUBLIC_DOMAIN}/public/`
            await fs.mkdir(prefix, { recursive: true })
            console.log(`${page} ${routes.length}x... => ${prefix}`)

            for (const route of routes) {    

                delete state.page

                let filepath = prefix + route.path.slice(route.path.at(0) === '/' ? 1 : 0)
                if (filepath.at(-1) !== '/' && filepath.slice(filepath.lastIndexOf('/')).indexOf('.') === -1) {
                    filepath += '/'
                }
                const isFolder = filepath.at(-1) === '/'
                if (isFolder && !mkdirCreated.includes(filepath)) {
                    await fs.mkdir(filepath, { recursive: true })
                    mkdirCreated.push(filepath)
                }
                const component = new Component(Compote, state, route.params) //{ state: state, attributes: route.params, props: route.props })
                output = await Compote.build(state, component, undefined, true)
                nbCharacters += output.length
                nbPages++
                if (options.includes('--progress')) console.log(`${Math.round(output.length / 1024)}KB ${filepath}`)
                await fs.writeFile(filepath + (isFolder ? 'index.html' : ''), output)

            }
        }

        const deltaTime = new Date() - startTime
        console.log(`\nwrited ${nbPages} files (${Math.round(nbCharacters/1024)}k characters) in ${deltaTime / 1000}s`)
    

    }

    // Serveur web
    if (options.includes('--dev')
    || options.includes('--build-pages')) {

        if (options.includes('--dev')) app.devMode = true
        if (process.env.DEV_PORT) defaultOptions.server.port = process.env.DEV_PORT
        if (process.env.PUBLIC_NAME) defaultOptions.server.paths.cache += `/${process.env.PUBLIC_NAME}`
        fsSync.mkdir(defaultOptions.server.paths.cache, { recursive: true }, (e) => e ? console.error(e) : null)

        http = (await import('http')).default
        https = (await import('https')).default
        Path = (await import('path')).default

        // Créé un serveur web n attente de connexion

        http.createServer(server).listen(defaultOptions.server.port)
        console.log(`\n${app.devMode ? 'Development' : 'Static'} server listening at http://localhost:${defaultOptions.server.port}/\n`);
        return
    }


    
    // Fichier source => out
    const doCompile = options.includes('--compile') || options.includes('--watch')
    const srcFolder = srcPath && !isFile(srcPath)
    
    
    // Compilation d'un dossier
    if (doCompile && srcFolder) {
    
        console.log(`Compilation of directory ${srcPath}`)
        const templates = await findComponentFiles(srcPath.at(-1) === '/' ? srcPath.slice(0, -1) : srcPath)
        for (const name in templates) {
            if ('html' in templates[name]) {
                const html = `${templates[name].html}`
                await compote([ '--compile', html, compiledPath ])
            }
        }
    }

    // Compilation d'un composant explicite
    if (doCompile && !srcFolder) {

        if (isFile(compiledPath)) {
            console.error(`compiled path need to be a directory`, { srcPath, compiledPath, args })
            process.exit(1)
        }

        console.log(`Compilation of file ${srcPath}`)

        // Prépare les variables
        for (const d in dependencies) delete dependencies[d]


        const idx = { lastSlash: srcPath.lastIndexOf('/') }
        const name = idx.lastSlash > -1 ? srcPath.replace('.html', '').slice(idx.lastSlash + 1) : srcPath
        const path = idx.lastSlash > -1 ? srcPath.slice(0, idx.lastSlash) : './'

        // Lit le fichier HTML
        const file = await fs.readFile(srcPath.replace('.html', '') + '.html', { encoding: 'utf-8' })
            .catch(e => exit(`can't read the file ${srcPath}.html !`, e))


        // Sépare les sections
        await sections(path, name, file)
            .catch(e => exit(e))

        if (code.style) compiled.style = code.style // compileStyle()
        code.style = null

        if (code.script) compiled.script = code.script // compileScript()
        code.script = null

        if (code.param) compiled.param = await compileData(code.param, 0)
            .catch(e => exit(`compile param ERROR`, e))
        code.param = null

        if (code.var) compiled.var = await compileData(code.var, 0)
            .catch(e => exit(`compile data ERROR`, e))
        code.var = null

        if (code.data) compiled.data = await compileData(code.data, 0)
            .catch(e => exit(`compile data ERROR`, e))
        code.data = null

        if (code.label) [compiled.label, compiled.scriptLabels] = await compileLabel(code.label, name)
            .catch(e => exit(`compile label ERROR`, e))
        code.data = null

        if (code.template) compiled.template = await compileTemplate(0, code.template.length)
            .catch(e => exit(`compile data ERROR`, e))
        code.template = null
        setContext(compiled.template, [])


        // Gère les chemins d'accès à ses composants
        for (const dep in dependencies) {
            dependencies[dep] = `#compiled/${dep}.tpl.mjs`
            // const exists = await fs.stat(dependencies[dep])
                // .catch(e => console.warn(`\x1b[31mDependence ${dep} not found\x1b[0m `))
        }

        // Vérifie s'il y a un fichier .mjs associé et l'inclus dans le code
        const mjs = await fs.readFile(srcPath.replace('.html', '.mjs'), { encoding: 'utf-8' })
            .catch(e => null)

        const idxClass = mjs ? mjs.indexOf(`class ${name}`) : -1
        const idxBracket = idxClass > -1 ? mjs.indexOf('{', idxClass) : -1
        let imports = ''
        let extend = ''
        if (mjs) {
            if (idxClass === -1 || idxBracket === -1) {
                console.error(`${name}.mjs doesn't include "class ${name}" or his bracket "{`)
            } else {
                extend = mjs.slice(idxBracket + 1, mjs.lastIndexOf('}'))
                const idxClassLine = mjs.lastIndexOf('\n', idxClass)
                if (idxClassLine > -1) imports = mjs.slice(0, idxClassLine + 1)
            }
        }

        // Génère le source de sortie
        const opt = { depth: Infinity, colors: false }
        const rawScript = compiled.script.replaceAll('`', '\\`').replaceAll('${', '\\${')
        await version()
        let output = `${imports}export default class ${name} {
        static ___ = {
            compote: '${compoteVersion}',
            component: ${name},
            dependencies: ${inspect(dependencies, opt)},
            prepared: 0,
            setup:  ${inspect(compiled.setup, opt)},
            param: ${inspect(compiled.param, opt)},
            var: ${inspect(compiled.var, opt)},
            data: ${inspect(compiled.data, opt)},
            label: ${inspect(compiled.label, opt)},
            scriptLabels: ${inspect(compiled.scriptLabels, opt)},
            script:  ${rawScript ? ['\`', rawScript, '\`'].join('') : "''" },
            style:  ${compiled.style ? ['\`', compiled.style.replaceAll('`', '\\'), '\`'].join('') : "''"},
            template:  ${inspect(compiled.template, opt)},
        }

        constructor(Compote, state, attributes, slot) {
            Compote.componentConstructor(this, ${name}, state, attributes, slot)
        }\n${extend}}`
        Object.keys(compiled).forEach((k,i) => compiled[i] = null)

        // Destination
        const outputFile = addPaths(compiledPath, `${name}.tpl.mjs`)
        const outputPath = outputFile.slice(0, outputFile.lastIndexOf('/'))

        // Vérifie l'existence ou crée le chemin de destination
        if (!(await fsSync.existsSync(outputPath))) {
            console.log(`create path ${outputPath}`)
            await fs.mkdir(outputPath, { recursive: true })
        }

        // Enregistre le fichier
        await fs.writeFile(outputFile, output)
            .catch(e => exit(`can't write the file ${outputFile} !`, e))

    }
}


async function sections(path, name, file) {

    const tags = {
        option:     { _: '<OPTION',     closingOpenTag: { _: '>', closer: '</OPTION>' } },
        param:      { _: '<PARAM',      closingOpenTag: { _: '>', closer: '</PARAM>' } },
        var:        { _: '<VAR',        closingOpenTag: { _: '>', closer: '</VAR>' } },
        data:       { _: '<DATA',       closingOpenTag: { _: '>', closer: '</DATA>' } },
        label:      { _: '<LABEL',      closingOpenTag: { _: '>', closer: '</LABEL>' } },
        template:   { _: '<TEMPLATE',   closingOpenTag: { _: '>', closer: '</TEMPLATE>' } },
        style:      { _: '<STYLE',      closingOpenTag: { _: '>', closer: '</STYLE>' } },
        script:     { _: '<SCRIPT',     closingOpenTag: { _: '>', closer: '</SCRIPT>' } },
    }    

    const next = indexOf({ text: file, searches: tags, start: 0, all: true, slices: false })

    // Vérifie qu'il y ait au moins l'un des tags requis et que chaque tag ouvert ait une fermeture 
    const atLeast = ['template', 'style', 'script']
    let foundRequired = 0    
    for (const tag of Object.keys(tags)) {
        if (next[tag] && next[tag]._ > -1) {
            if (!(next[tag].closingOpenTag?.closer?._ > -1)) throw new Error(`> compile ${name} - ERROR: not found the closing tag </${tag.toUpperCase()}> (case sensitive)`)
            if (atLeast.includes(tag)) foundRequired++

            // Extrait le code et enlève le 1er et dernier saut de ligne à l'intérieur si nécessaire
            const sectionStart = next[tag].closingOpenTag.$
            const sectionStop = next[tag].closingOpenTag.closer._
            code[tag] = file.slice(
                sectionStart + (file.at(sectionStart) === "\n" ? 1 : 0), 
                sectionStop - (file.at(sectionStop - 1) === "\n" ? 1 : 0))


            // Analyse les attributs
            const attributes = file.slice(next[tag].$, next[tag].closingOpenTag._).trim().split(' ')
            for (const a of attributes) {


                // Contenu à importer depuis un fichier externe
                if (a.startsWith('import=')) {
                    const toImport = `${path}/` + a.slice('import='.length).replaceAll('"', '').replaceAll("'", '')

                    const importedFile = await fs.readFile(toImport, { encoding: 'utf-8' })
                        .catch(e => exit(`can't read the file ${toImport} !`, e))
                        
                    if (importedFile) {
                        
                        // Si cette fonction vide existe, on la remplace par celui de la balise SCRIPT
                        if (tag === 'script') {
                            const asideScript = `function script${name}() {}`
                            const idx = importedFile.indexOf(asideScript)
                            if (idx > -1) {
                                code[tag] = importedFile.slice(0, idx + asideScript.length - 1)
                                    + `\n${code[tag]}\n`
                                    + importedFile.slice(idx + asideScript.length - 1)
                            }
                            else code[tag] = importedFile + code[tag]
                        }

                        else code[tag] = importedFile + code[tag]
                    }                
                }

                // Hoister pour les script/style
                if (a === 'hoist') compiled.setup.hoist[tag] = true
                
            }
        }
        else code[tag] = ''
    }
    if (!foundRequired) throw new Error(`> compile ${name} : Not found any of one of required tags: <TEMPLATE></TEMPLATE>, <STYLE></STYLE> or <SCRIPT></SCRIPT> (case sensitive)`)

}





/**
 * Convertit le code « key: valeur » en objet
 * Renvoi la prochaine clef
 * Le caractère espace n'est pas autorisé dans le nom des clefs
 * 
 * @param {string} code
 * @returns {objet}
 */
async function compileData(code, position = 0, data = {}) {

    // Convertion en format « x.y.z=value »
    const is = {}
    const idx = { n: 0 }
    const lines = code.split("\n")
    const paths = []
    const newLines = []
    let gapWidth

    for (const line of lines) {

        idx.column = line.indexOf(':')
        is.set = idx.column > -1
        const value = is.set ? line.slice(idx.column + 1).replace("\t", '').trim() : false
        idx.endKey = is.set ? idx.column : line.trimEnd().length
        const keyWithGaps = line.slice(0, idx.endKey)
        const key = keyWithGaps.replaceAll("\t", '').trim()
        const gap = keyWithGaps.length - key.length
        if (gap) gapWidth ??= gap
        const depth = gapWidth ? gap / gapWidth : 0

        let cut = depth < paths.length
        if (cut) {
            cut = paths.slice(depth).join('.')
            paths.length = depth
        }
        if (!is.set) {
            paths.push(key)
        }

        if (is.set) {
            const before = paths.length ? paths.join('.') + '.' : ''
            newLines.push( `${before}${key}=${value}` )
        }
    }

    // Création de l'objet data
    function setData(path, value, data = {}) {
        idx.dot = path.indexOf('.')
        const key = path.slice(0, idx.dot > -1 ? idx.dot : path.length)

        if (idx.dot === -1) {
            data[key] = value
            return data
        }
        data[key] = setData(path.slice(idx.dot + 1), value)
        return data
    }

    for (const line of newLines) {
        idx.equals = line.indexOf('=')
        const path = line.slice(0, idx.equals)
        let value = line.slice(idx.equals + 1)
        const isNumeric = Number.parseFloat(value)
        if (value == isNumeric) value = isNumeric
        else if (value === 'true') value = true
        else if (value === 'false') value = false
        mergeObjects(data, setData(path, value))
    }
    return data
}


async function compileLabel(code, className) {
    const labels = {}
    const scriptLabels = []

    const lines = code.split("\n")

    // Recherche un 1er libellé
    for (let l=0; l < lines.length; l++) {
        let label = lines[l].trim()
        if (!label) continue
        if (label.at(0) === '+') {
            label = label.slice(1)
            scriptLabels.push(label.replace('()', ''))
        }
        const fnLabel = label.slice(-2) === '()'

        if (label.indexOf(' ') > -1) throw Error(`LABEL ERROR white space in label name is invalid`, { '#': l, label })
        if (label.indexOf('.') > -1) throw Error(`LABEL ERROR dot point in label name is invalid`, { '#': l, label })
        if (label.indexOf(':') > -1) throw Error(`LABEL ERROR column character in label name is invalid`, { '#': l, label })

        // On récupère ses traductions par locale qui doivent être sous ce libellé
        const translations = {}
        let locale 
        for (++l; l < lines.length; l++) {
            const translate = lines[l].trim()
            if (!translate) continue

            const column = translate.indexOf(':')            
            if (column === -1) {
                
                // Vérifie s'il s'agit du libellé suivant et non pas une erreur de format
                if (Object.keys(translations).length && translate.indexOf(' ') === -1) {
                    l--;
                    break
                }

                // Erreur de format sauf s'il s'agit d'un libellé de fonctions
                if (!fnLabel || translate.at(0) !== '(') {
                
                    throw Error(`LABEL ERROR wrong format for the translation of the label « ${label} » ( #${l} => «${translate}» )`)
                }
            }
            if (column > -1) locale = translate.slice(0, column)

            if (fnLabel) {
                if (!(locale in translations)) translations[locale] = {}
                let condition = '*'
                let translation = column > -1 ? translate.slice(column + 1).trim() : translate
                const endCondition = translation.indexOf(')')
                if (translation.at(0) === '(' && endCondition > -1) {
                    condition = translation.slice(1, endCondition) || '*'
                    translation = translation.slice(endCondition + 1).trim()
                }
                else {
                    translation = translate.slice(column + (translate.at(column + 1) === ' ' ? 2 : 1))
                }
                translations[locale][condition] = translation
            } 
            else {
                const translation = translate.slice(column + (translate.at(column + 1) === ' ' ? 2 : 1))
                translations[locale] = translation
            }
        }
        if (!Object.keys(translations).length) throw Error(`LABEL ERROR no translation found for the label « ${label} »`, { '#': l, label })

        for (const locale in translations) {
            if (!labels.hasOwnProperty(locale)) labels[locale] = {}
            if (label.slice(-2) === '()') {
                labels[locale][label.replace('()', '')] = translations[locale] // new Translation({ locale, label, translation: translations[locale], className })
            } else {
                labels[locale][label] = translations[locale]
            }
        }
    }

    return [ labels, scriptLabels ]
}





/*
    component:  
        « <MonComposant(...)/> »  ou « <MonComposant></MonComposant> » ( Majuscule )
    empty element:
        « <img(...)> » ou « <img(...)/> » et tous ceux listé par le W3C, sans « closing tag »
    element:
        « <ul>(...)</ul> » tous les autres éléments, dont:
        opening tag: « <ul> »
        closing tag: « </ul> »


    Le tableau de sortie représente des chaînes de textes brutes ou un tableau de 3 élements:
        - nom de l'instruction
        - tableau de paramètres à cet instruction
        - enfants 


*/
async function compileTemplate(start, stop, depth=0, parentTag='') {

    const syntax = defaultOptions.syntax
    const searches = {

        comment: {
            _: '<!--',
            closer: '-->',
        },
    
        cdata: { 
            _: '<![CDATA[',
            closer: ']]>',
        },
        
        emptyElement: {
            _: idxEmptyElement,
            closingEmptyElement: idxClosingEmptyElement,
        },

        component: {
            _: idxComponent,
    
            closingElement: '/>',
            closingOpenTag: {
                _: '>',
                closer: idxClosingOpenTag,
            }
        },
    
        element: {
            _: idxElement,
    
            closingElement: '/>',
            closingOpenTag: {
                _: '>',
                closer: idxClosingOpenTag,
            }
        },
    
        expression: {
            _: syntax.opener,

            if: {
                _: 'if ',
                closer: idxExpressionCloser,
            },
    
            for: {
                _: 'for ',
    
                of: {
                    _: ' of ',
                    closer: idxExpressionCloser,
                },
    
                in: {
                    _: ' in ',
                    closer: idxExpressionCloser,
                },

                to: {
                    _: ' to ',
                    closer: idxExpressionCloser,
                },
            },

            closer: idxExpressionCloser,
        },

        bypass: {
            _: `${syntax.opener}${syntax.bypass}`,
            closer: syntax.closer,
        },
    
    }

    const parts = []
    const slice = code.template.slice.bind(code.template)
    const push = (add, conditions=[]) => {
        if (!add) return
        if (!conditions.length) return parts.push(add)

        for (const cond of conditions) {
            cond[1] = [ add ]
            add = cond
        }
        parts.push(add)
    }


    while (start < stop) {

        // Recherche la 1ère interaction à gérer ( commentaires, CDATA, expression ou composant )
        const n = indexOf({ text: code.template, searches, start, stop, slices: true })

        if (n._1st._ === -1) {
            const untilStop = slice(start, stop)
            if (defaultOptions.noGap && untilStop.replaceAll("\n", '').trim()) {
                push(untilStop)
            }
            break
        }

        // Partie précédent une nouvelle interaction
        const untilInteraction = slice(start, n._1st._)
        if (defaultOptions.noGap && untilInteraction.replaceAll("\n", '').trim()) {
            push(untilInteraction)
        }

        // Quelle est la 1ère interaction
        let end, toPush
        switch (n._1st._key) {

            case 'element':
            case 'component':
                n.tag = n._1st
                const tag = n.tag['…'].slice(1)
                if (n._1st._key === 'component' && tag !== 'Compote') dependencies[tag] = ''

                // Element sans enfant
                if (n.tag._1st._key === 'closingElement') {
                    const [ attributes, conditions ] = await attributesAndConditions(n.tag.$, n.tag.closingElement._, n.tag.closingElement['…'], n._1st._key)
                    push([
                        {   
                            _: tag, 
                            __: attributes,
                        }
                    ], conditions)
                    start = n.tag.closingElement.$
                    continue
                }

                // Element avec enfants
                if (n.tag._1st._key === 'closingOpenTag') {

                    if ([undefined, -1].includes(n.tag.closingOpenTag?.closer?._)) {
                        exit(`Element with childrens not correctly closed: ${n.tag._key} «${code.template.slice(n.tag._, n.tag._ + 20)}»`, n)
                        start = n.tag._ + 1
                        continue
                    }
                    n.closingTag = n.tag.closingOpenTag.closer
                    // n.closingTag.$ = n.closingTag._ + n.tag['…'].length + '/<'.length
                    const [ slotStart, slotEnd ] = [ n.tag.closingOpenTag.$, n.closingTag.$ ]
                    const slot = await compileTemplate(slotStart, slotEnd, depth + 1, tag)
                    const [ attributes, conditions ] = await attributesAndConditions(n.tag.$, n.tag.closingOpenTag._, n.tag.closingOpenTag['…'], n._1st._key)
                    push([
                        { 
                            _: tag,
                            __: attributes,
                        },
                        [ ...slot ],
                    ], conditions)
                    start = n.closingTag.$ + `</${tag}>`.length
                    continue
                }
                return exit(`INTERNAL ERROR #2`, n)


            case 'emptyElement':

                const [ attributes, conditions ] = await attributesAndConditions(n.emptyElement.$, n.emptyElement.closingEmptyElement._, n.emptyElement.closingEmptyElement['…'], n._1st._key)
                push([ 
                    { 
                        _: n.emptyElement['…'].slice(1),
                        __: attributes,
                    }
                ], conditions)
                start = n.emptyElement.closingEmptyElement.$
                continue

            case 'bypass':
                n.expression.operator = n.expression._1st
                push(defaultOptions.syntax.opener)
                start = n.expression.bypass.$
                continue

            case 'expression':
                n.expression.operator = n.expression._1st

                switch (n.expression.operator._key) {

                    case 'if':
                        if (!(n.expression.if.closer?._ > -1)) {
                            console.warn(`expression at #${n.expression._} « if » require a closing bracket!`)
                            start = n.expression._ + 1
                            continue
                        }
                        push([ 
                            { if: new Expression(slice(n.expression.if.$, n.expression.if.closer._), ) },
                            [],
                        ])
                        start = n.expression.if.closer.$
                        continue

                    case 'for':
                        n.expression.for.type = n.expression.for._1st
                        if (!['of', 'in', 'to'].includes(n.expression.for.type._key)) {
                            console.warn(`expression at #${n.expression._} « for » require a type of loop « of », « in » or « to » !`)
                            start = n.expression._ + 1
                            continue
                        }
                        if (!(n.expression.for.type.closer?._ > -1) ) {
                            console.warn(`expression at #${n.expression._} « for » require a closing bracket!`)
                            start = n.expression._ + 1
                            continue
                        }

                        const kind = n.expression.for.type._key.trim()
                        const _for = {}
                        _for[kind] = new Expression(slice(n.expression.for.type.$, n.expression.for.type.closer._))
                        _for.v = slice(n.expression.operator.$, n.expression.for.type._)
                        const setValue = _for.v.split('=')
                        if (kind === 'to' && setValue.length > 1) {
                            _for.v = setValue[0]
                            _for.from = setValue[1].trim() * 1
                        }
                        
                        push([_for, [] ])
                        start = n.expression.for.type.closer.$
                        continue


                    default: // Valeur ou code javascript
                        if (!(n.expression.closer?._ > -1)) {
                            console.warn(`expression at #${n.expression._} « value » require a closing bracket!`)
                            start = n.expression._ + 1
                            continue
                        }
                        const isSlot = code.template.startsWith(syntax.slot, n.expression.$)

                        const unprotected = isSlot || code.template.startsWith(syntax.unprotected, n.expression.$)
                        const encode = unprotected ? false : defaultOptions.encode.auto

                        const x = slice(unprotected ? n.expression.$ + syntax.unprotected.length : n.expression.$ , n.expression.closer._)
                        
                        toPush = isSlot ? [{s: new Slot(x) }] : [{x: new Expression(x) }]
                        push(encode ? [{e: '>'}, toPush] : toPush)
                        start = n.expression.closer.$
                }
                continue

            case 'comment':
            case 'cdata':
                n.skip = n._1st
                end = start = n.skip.closer?.$ ?? stop
                push( slice(n.skip._, end) )
                continue

            default:
                return exit(`INTERNAL ERROR #1`, n)

        }
    }
    return parts
}


async function attributesAndConditions(start, stop, closer, type) {
    const conditions = []
    const attributes = {}
    const searches = {
        equals: {
            _: '=',
            dQuote: {
                _: '"',
                end: '"',
            },
            sQuote: {
                _: "'",
                end: "'",
            },
            expression: {
                _: "{",
                end: idxExpressionCloser,
            },
            space: ' ',
            bracket: '>',
        },
        space: ' ',
        bracket: '>',

        for: {
            _: "{for ",
            end: idxExpressionCloser,
        },
        if: {
            _: "{if ",
            end: idxExpressionCloser,
        },
        expression: {
            _: "{",
            end: idxExpressionCloser,
        },

     }

     const attrExpression = async (from, attribute) => {

        if (!('end' in from)) {
            console.warn('end of attribute error', { from, attribute })
            return 1
        }
        const attrCompiled = await compileTemplate(from._, from.end.$)
        const aa = attributes[attribute] = attrCompiled[0]

        if (Array.isArray(aa) && aa[0] instanceof Object && 'e' in aa[0]) {
            let previousCharacter = code.template[from._ - 1]
            if (previousCharacter === '=') previousCharacter = defaultOptions.attributes.addMissingQuotes
            attributes[attribute][0].e = previousCharacter
        }
        return from.end.$
     }

     while (start < stop && start > -1) {

        const n = indexOf({ text: code.template, searches, start, stop })

        // Attribut avec valeur
        if ('equals' in n) {
            const attribute = code.template.slice(start, n.equals._).trim()

            // Expression
            if ('expression' in n.equals) {
                start = await attrExpression(n.equals._1st, attribute)
            }

            // Entre quotes
            else if (('dQuote' in n.equals && 'end' in n.equals.dQuote) || ('sQuote' in n.equals && 'end' in n.equals.sQuote)) {
                attributes[attribute] = code.template.slice(n.equals._1st._, n.equals._1st.end.$)
                start = n.equals._1st.end.$
            }

            // Sans quote
            else {
                const end = n.equals._1st._ > -1 ? n.equals._1st._ : stop
                attributes[attribute] = code.template.slice(n.equals.$, end)
                start = n.equals._1st.$
            }
        }

        // Expression sans clef/valeur
        else if ('expression' in n) {
            start = await attrExpression(n.expression, `${Object.keys(attributes).length}`)
        }

        // Conditions if / for
        else if ('for' in n || 'if' in n) {
            const [ condition ] = await compileTemplate(n._1st._, n._1st.end.$)
            conditions.push(condition)
            start = n._1st.end.$
        }

        // Attribut booléen sans valeur
        else {     
            const end = n._1st._ > -1 ? n._1st : { _: stop, $: stop }
            const attribute = code.template.slice(start, end).trim()
            if (attribute) {

                // Expression classique ou texte brut
                /*
                const [ expression ] = await compileTemplate(start, end._)
                console.log({ attribute, n, slice: code.template.slice(start, end._), expression })
                if (Array.isArray(expression)) {
                    if (expression[0] instanceof Object && 'e' in expression[0]) {
                        expression[0].e = ' '
                    }
                }
                else */attributes[attribute] = true
                start = end.$
            } 
            else start = end.$

        }
    }
    if (closer[0] === '/') attributes['/'] = 1
    conditions.reverse()
    return [ attributes, conditions ]
}


function setContext(list, context) {

    list.map(pair => {

        if (typeof pair === 'string') return
        if (Array.isArray(pair) && pair[0] instanceof Object) {
            const [ type, slot ] = pair

            let kind
            for (kind in type) break

            let isFor = ['of', 'in', 'to'].includes(kind) ? kind : false // 'of' in type ? 'of' : 'in' in type ? 'in' : false
            let isIf = kind === 'if' ? kind : false // 'if' in type ? 'if' : false
            let isExpr = ['x', 's'].includes(kind) ? kind : false // 'x' in type ? 'x' : 's' in type ? 's' : false
            if (isFor) {
                if (!context.includes(type.v)) {
                    type[isFor].extraVars = [...context, type.v]
                } else {
                    type[isFor].extraVars = [...context ]
                }

                if (slot !== undefined) {
                    setContext(slot, type[isFor].extraVars)
                }
            }
            else {
                if (isIf) {
                    type[isIf].extraVars = [...context]
                }
                else if (isExpr) {
                    type[isExpr].extraVars = [...context]
                }
                else if ('__' in type) {
                    for (const k in type.__) {
                        if (Array.isArray(type.__[k])) {
                            setContext([type.__[k]], context)
                        }
                    }
                }

                if (slot !== undefined) {
                    let pairSlot = 'e' in type
                    setContext(pairSlot ? [ slot ] : slot, context)
                }
            }
        }
    })
}


async function directoryTree(path) {
    const paths = []

    const files = await fs.readdir(path, { withFileTypes: true })
    .catch(e => exit(`can't read the directory « ${path} » !`, e))

    for (const file of files) {
        if (!file.isDirectory()) continue
        const subpath = `${path}/${file.name}`
        paths.push(subpath)
        const sub = await directoryTree(subpath)
        for (const s of sub) {
            paths.push(s)
        }
    }
    return paths
}


// Fichiers composant (avec une majuscule, .html, .mjs, .js, .css)
// { Component: [ html: path, css: path, js: path, mjs: path(.mjs ou .tpl.mjs) ] }
async function findComponentFiles(path) {

    let paths = {}
    const files = await fs.readdir(path, { withFileTypes: true })
        .catch(e => exit(`can't read the directory « ${path} » !`, e))

    for (const file of files) {
        if (file.isDirectory()) {
            const sub = await findComponentFiles(`${path}/${file.name}`)
            paths = { ...sub, ...paths }
        }
        else if (file.name[0] === file.name[0].toUpperCase() && file.name[0] !== file.name[0].toLowerCase()) {
            const dot = file.name.indexOf('.')
            if (dot === -1) continue

            const componentName = file.name.slice(0, dot)
            let ext = file.name.slice(dot + 1)
            if (!(componentName in paths)) paths[componentName] = {}

            if (ext === 'tpl.mjs') {
                if ('mjs' in paths[componentName]) continue
                ext = 'mjs'
            }
            paths[componentName][ext] = `${path}/${file.name}`
        }
    }

    return paths
}



// ### TOOLS ##################################################################

function min(a, b) { return a < b ? a : b }
function max(a, b) { return a > b ? a : b }



/**
 * Recherche dans « str » la position la plus proche d'une occurence de l'objet « searches »
 * Si l'option « all » est indiquée, on renvoie également
 * 
 *  
 * 
 * @date 2022-02-05
 * @param {string} text             Chaîne de recherche
 * @param {object} searches        Objet des recherches { une: recherche1, autre: recherche2, ... }
 *                                  Possibilité imbriqués { une: { _: recherche1, end: recherche2 }, ... }
 *                                  Possibilité de fonction booléenne personnalisée: { une: () => {...} }
 * @param {number} start           Où commencer
 * @param {number} stop            Jusqu'où chercher
 * @param {boolean|object} all     À false on s'arrête à la 1ère trouvée, à true on cherche
 *                                  et sinon un object { nom: true/false } pour être précis
 * @param {boolean} slices         Renvoie la partie capturée
 * 
 * @returns {object}               Objet contenant toues les positions demandées
 *                                  + 'one' et 'idx' contenant le nom/position de 1ère trouvée
 */
function indexOf(index) {
    const { text, searches, start, stop, all = false, slices = false, history } = index
        
    const next = { _1st: { _: -1, $: -1, _key: '' } }
    const nb = all === false ? 1 : Object.keys(all === true ? searches : all).length
    const max = stop ?? text.length
    const subkeys = {}
    let idx = -1

    // Si « searches » contient des recherches imbriquées, le transforme pour optimiser le délai
    const firstSearches = {}
    for (const key in searches) {
        const type = typeof searches[key]
        if (type === 'string' || type === 'function') {
            firstSearches[key] = searches[key]
            continue
        }
        if (type === 'object') {
            for (subkeys[key] in searches[key]) {
                firstSearches[key] = searches[key][ subkeys[key] ]
                break
            }
            continue
        }
    }

    let len
    const state = {}
    for (let i=start; i < max; i++) {
        const c = text.at(i)
        const cc = text.at(i+1)
        for (const key in firstSearches) {

            // Ne cherche qu'une seule fois l'occurence d'une clef
            if (next.hasOwnProperty(key)) continue

            // Si la function personnalisé renvoie bien la longueur du texte trouvé
            if ((typeof firstSearches[key] === 'function' && (len = firstSearches[key](index, { c, cc, i, key }, state)) !== false)

            // Ou que le 1er caractère puis la chaîne entière correspondent  
            || (firstSearches[key][0] === c && text.startsWith(firstSearches[key], i))) {

                // Prépare ses informations
                const infos = next[key] = { 
                    _: i,
                    $: i + (typeof firstSearches[key] === 'function' ? len : firstSearches[key].length),
                    _key: key,
                }
                if (slices) next[key]['…'] = text.slice(i, next[key].$)
                

                // S'il s'agit de la première recherche trouvée
                if (idx === -1) {
                    idx = i
                    next._1st = next[key]
                }

                // Recherches conditionnelles imbriquées
                if (subkeys.hasOwnProperty(key)) {
                    const firstKey = subkeys[key]
                    const remainingSearches = { ...searches[key] }
                    remainingSearches[firstKey] = null
                    if (Object.keys(remainingSearches).length) {
                        const nextIndexOf = indexOf({ 
                            ...index, 
                            searches: remainingSearches, 
                            start: infos.$, 
                            history: { _parent: { ...history, ...infos } } 
                        })
                        for (const n in nextIndexOf) next[key][n] = nextIndexOf[n]
                    }
                }

                // Cherche le 1er match uniquement
                if (all === false) {
                    // next[key] = null
                    return next
                }

                // Toutes les recherches ont été faites
                if (Object.keys(next) === nb + 1) return next       // +1 pour « _1st »
            }

        }
    }

    return next
}

function idxComponent(index, loop) {
    if (loop.c !== '<' || loop.cc === '/') return false
    const len = idxComponentName(index, { ...loop, i: loop.i+1, c: loop.cc, cc: index.text.at(loop.i + 2) })
    return len === false ? false : len + 1
}
function idxComponentName(index, loop) {
    if (loop.c !== loop.c.toUpperCase() || loop.c === loop.c.toLowerCase()) return false
    let len = 1
    for (; len < index.stop; len++) {
        const letter = index.text[loop.i + len]
        if (letter.toUpperCase() === letter.toLowerCase()
        && !(letter >= '0' && letter <= '9')) break
    }
    return len
}


function idxEmptyElement(index, loop) {
    if (loop.c !== '<' || loop.cc == '/') return false
    const len = idxEmptyElementName(index, { ...loop, i: loop.i+1, c: loop.cc, cc: index.text.at(loop.i+2) })
    return len === false ? false : len + 1
}
function idxEmptyElementName(index, loop) {
    for (const el of emptyElements) {
        if (loop.c === el[0] && index.text.startsWith(el, loop.i)) return el.length
    }
    return false
}


function idxElement(index, loop) {
    if (loop.c !== '<') return false
    const len = idxElementName(index, { ...loop, i: loop.i+1, c: loop.cc, cc: index.text.at(loop.i+2) })
    return len === false ? false : len + 1
}

function idxElementName(index, loop) {
    if (loop.c.toUpperCase() === loop.c.toLowerCase()) return false
    let len = 1
    for (; len < index.stop; len++) {
        const letter = index.text[loop.i + len]
        if (letter.toUpperCase() === letter.toLowerCase()
        && !(letter >= '0' && letter <= '9') && letter !== '-') break
    }
    return len
}

function idxExpressionCloser(index, loop, state) {
    if (loop.c === defaultOptions.syntax.opener) {
        if (!('nestedOpener' in state)) state.nestedOpener = 0
        state.nestedOpener++
        return false
    }
    else if (loop.c === defaultOptions.syntax.closer) {
        if (!('nestedOpener' in state)) state.nestedOpener = 0
        return --state.nestedOpener < 0 ? 1 : false
    }
    else return false
}

function idxClosingOpenTag(index, loop, state) {
    // if (loop.c !== '<') return false
    const closingOpenTag = index.history._parent
    const tag = closingOpenTag._parent['…'].slice(1)
    const searches = {
        open: {
            _: `<${tag}`,
            space: ' ',
            bracket: '>',
        },
        close: `</${tag}>`,
    }
    for (let i=loop.i, opened=1; i < index.text.length && i !== -1; ) {
        const r = indexOf({ text: index.text, searches, start: i, stop: index.text.length, slices: true })
        i = r._1st.$
        if (r._1st._key === 'open' && ['space', 'bracket'].includes(r.open._1st._key)) {
            opened++
            continue
        }
        if (r._1st._key === 'close') {
            opened--
            if (!opened) {
                return r.close._ - loop.i
            }
        }
    }
    return false
    

}


function idxClosingEmptyElement(index, loop) {
    if (loop.c === '>') return 1
    if (loop.c === '/' && loop.cc === '>') return 2
    return false
}



// -----------------------------

// function pathValue(path, obj=self, separator='.') {
    // return path.split('.').reduce((p, c) => p && p[c] || null, obj)
// }


function mergeObjects(set, defaults) {
    for (const opt in defaults) {

        const exists = set.hasOwnProperty(opt)
        const nested = typeof defaults[opt] === 'object' && !Array.isArray(defaults[opt])

        if (!nested) {
            if (exists) continue
            set[opt] = defaults[opt]
            continue
        }
        if (!exists) set[opt] = {}
        mergeObjects(set[opt], defaults[opt])
    }
    return set
}


configFile()
compote(process.argv.slice(2))
