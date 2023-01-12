/*
import Builder from '#components/ComponentBuilder.mjs'
import { readFile, writeFile, mkdir, readdir } from 'fs/promises'


const envFile = async (filename, state) => {
    const env = await readFile(filename, { encoding: 'utf-8' })
        .catch(e => console.error(`\x1b[31mEnvironment file « ${filename} » not found\x1b[0m`))
    
    const lines = env.trim().split("\n")
    for (const l of lines) {
       const line = l.trim()
       if (line[0] === '#') continue
       const equals = line.indexOf('=')
       if (equals < 1) { 
           console.error(`Environment file format invalid`, { line })
           continue
       }
       const key = line.slice(0, equals).trim()
       const value = line.slice(equals + 1)
       process.env[key] = value
       state[key] = value
    }
}


async function start(component, jsonAttributes, options) {
    const startTime = new Date()
    let characters = 0
    let pages = 0
    
    if (!component && !options.includes('--all-pages')) {
        console.log(`node builder [./path/MyComp.mjs] ["{JSON attributes}"] [--all] [--show]`)
        console.log(`node builder ./components/pages/MyPage.mjs "{slug:...,id:...}"`)
        console.log(`node builder ./components/pages/MyPage.mjs --all`)
        console.log(`node builder --all-pages`)
        process.exit(1)
    }

    const state = { env: {}}

    if (process.env.ENV) {
        envFile(process.env.ENV, state.env)
        delete process.env.ENV
    }
    state.locale = state.env.PUBLIC_LANG || 'fr'
    let output

    const toBuild = []
    if (options.includes('--all-pages')) {
        const pathPages = './components/pages/'
        const files = await readdir(pathPages)
        const ext = '.mjs'
        const tpl = '.tpl.mjs'
        for (const f of files) {
            if (f.slice(tpl.length * -1) === tpl) continue
            if (f.slice(ext.length * -1) === ext) toBuild.push(pathPages + f)
        }
    } else {
        toBuild.push(component)
    }

    try {
        const mkdirCreated = []
        let attributes = JSON.parse(jsonAttributes ?? '{}')
        for (const component of toBuild) {
            state.components = {}
            state.scriptLabels = {}
            const RequestedComponent = (await import(component)).default
            const componentName = RequestedComponent.name
            state.components[componentName] = RequestedComponent
            await Builder.loadDependencies(RequestedComponent, state.components, true, state)

            if (options.includes('--all') || options.includes('--all-pages')) {
                const all = await RequestedComponent.routes()
                console.log(`${component} ${all.length}x...`)
                const prefix = `./build/${state.env.PUBLIC_DOMAIN}/`
                await mkdir(prefix, { recursive: true })

                for (const route of all) {
                    let filepath = prefix + route.path.slice(route.path.at(0) === '/' ? 1 : 0)
                    if (filepath.at(-1) !== '/' && filepath.slice(filepath.lastIndexOf('/')).indexOf('.') === -1) {
                        filepath += '/'
                    }
                    const isFolder = filepath.at(-1) === '/'
                    if (isFolder && !mkdirCreated.includes(filepath)) {
                        await mkdir(filepath, { recursive: true })
                        mkdirCreated.push(filepath)
                    }
                    const newState = { ...state }
                    const requestedComponent = new RequestedComponent(newState, route.params) //{ state: newState, attributes: route.params, props: route.props })
                    output = await Builder.build(newState, requestedComponent)
                    characters += output.length
                    pages++
                    if (options.includes('--progress')) console.log(`${Math.round(output.length / 1024)}KB ${filepath}`)
                    await writeFile(filepath + (isFolder ? 'index.html' : ''), output)
                }

            } else {
                const requestedComponent = new RequestedComponent(state, attributes)
                output = await Builder.build(state, requestedComponent)
            }
        }
    }
    catch (error) {
        console.error('\x1b[31m%s\x1b[0m', { BUILD_ERROR: error}, error)
        process.exit(1)
    }

    if (options.includes('--show')) {
        console.log( output )
        process.exit(0)
    }

    if (options.includes('--all') || options.includes('--all-pages')) {
        const deltaTime = new Date() - startTime
        console.log(`writed ${pages} files (${Math.round(characters/1024)}k characters) in ${deltaTime / 1000}s`)
    }    
}


// Détection des paramètres
// [composant] [jsonAttributes] [--option] [--option]
const args = process.argv.slice(2)
const component = !args.at(0)?.startsWith('--') ? args.at(0) : undefined
const jsonAttributes = args.at(1)?.startsWith('--') ? undefined : args.at(1)
const options = []
for (const a of args) {
    if (a.startsWith('--')) options.push(a)
}

start(component, jsonAttributes, options)

*/