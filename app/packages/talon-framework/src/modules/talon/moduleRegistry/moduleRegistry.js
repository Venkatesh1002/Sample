import * as lwc from '@lwc/engine';
import { assert, autoBind } from 'talon/utils';
import { getBasePath, getMode, getLocale } from 'talon/configProvider';
import { getResourceUrl, getViewModuleFullyQualifiedName } from 'talon-common';
import scopedModuleResolver from 'talon/scopedModuleResolver';

const NAMESPACE_ALIASES = {
    'lightning': 'interop'
};

/**
 * Module registry class.
 *
 * A single instance of it will be used throughout the app
 * and selected methods will be exported.
 *
 * We still export the class itself for testing purpose so that we can
 * create as many instances as needed.
 */
export class ModuleRegistry {
    registry = {};
    resourceUids;

    /**
     * Assert that the dependency exists in the registry.
     * @param {String} dependency - the name of the dependency
     */
    assertHasModule(dependency) {
        assert(this.hasModule(dependency), `Cannot resolve dependency '${dependency}'`);
    }

    /**
     * Add multiple modules to the registry.
     *
     * This function is different from addModule() in the sense that it takes
     * already exported modules rather than an exporter function for the modules.
     *
     * This function can be used with labels, LWC component, ES modules.
     *
     * This function is meant to be called by code generated by the framework.
     *
     * @param {Object} modulesByName - A map of modules to add to the registry,
     *                  keyed by module name and in which values are exported modules.
     */
    addModules(modulesByName) {
        Object.entries(modulesByName).forEach(([name, module]) => {
            this.registry[name] = module;
        });
    }

    /**
     * Add a single module to the registry.
     *
     * This function is meant to be called by code generated by the framework.
     *
     * Modules should only exported/evaluated once, the call is ignored if the module
     * is already registered.
     *
     * @param {string} name - The name of the module to add
     * @param {string[]} dependencies - The list of dependencies to pass to the exporter function
     * @param {Function} exporter - A function that will export the module to add.
     */
    define(name, dependencies, exporter) {
        this.addModule(null, name, dependencies, exporter);
    }

    /**
     * Add a single module to the registry.
     *
     * This function is meant to be called by code generated by the framework.
     *
     * Modules should only exported/evaluated once, the call is ignored if the module
     * is already registered.
     *
     * @param {string} descriptor - Not used, kept here for Aura compatibility reasons
     * @param {string} name - The name of the module to add
     * @param {string[]} dependencies - The list of dependencies to pass to the exporter function
     * @param {Function} exporter - A function that will export the module to add.
     */
    addModule(descriptor, name, dependencies, exporter) {
        if (exporter === undefined && typeof dependencies === 'function') {
            // amd define does not include dependencies param if no dependencies.
            this.addModule(descriptor, name, [], dependencies);
            return;
        }

        // ignore if module is already registered
        if (this.registry[name]) {
            return;
        }

        const moduleExports = {};
        this.registry[name] = exporter.apply(undefined, dependencies.map(dependency => {
            if (name === dependency) {
                return this.evaluateCircularDependency(name);
            }

            return this.evaluateModuleDependency(dependency, moduleExports);
        })) || moduleExports;
    }

    /**
     * Returns a Proxy delegating to the module from the registry
     * with the specified name.
     *
     * This is useful for circular dependencies when the module is not in the
     * registry yet at the time to evaluate it.
     *
     * @param {*} name The name of the module
     */
    evaluateCircularDependency(name) {
        const registry = this.registry;
        return new Proxy({}, {
            get(obj, prop) {
                return registry[name][prop];
            }
        });
    }

    /**
     * Evaluate module dependency from its full import name.
     *
     * eg 'lwc' or 'lightning/button' or '@salesforce/cssvars/customProperties'
     *
     * @param {string} dependency - A dependency name
     * @param {string} moduleExports - The dependency's exports
     */
    evaluateModuleDependency(dependency, moduleExports) {
        // Found itself
        if (this.registry[dependency]) {
            return this.registry[dependency];
        }

        // Handle special cases
        if (dependency === 'lwc') {
            return lwc;
        } else if (dependency === 'exports') {
            return moduleExports;
        }

        if (dependency.startsWith('@')) {
            // Handle scoped modules
            this.registry[dependency] = scopedModuleResolver.resolve(dependency);
        } else {
            // Handle unscoped case
            const [moduleName, component] = dependency.split('/');
            this.registry[dependency] = this.evaluateUnscopedModuleDependency(moduleName, component);
        }

        this.assertHasModule(dependency);
        return this.registry[dependency];
    }

    /**
     * Evaluate unscoped dependency from its module name and component.
     *
     * eg 'lightning/button' or 'interop/menuItem'
     *
     * @param {string} moduleName - An unscoped module
     * @param {string} component - The component name
     */
    evaluateUnscopedModuleDependency(moduleName, component) {
        if (NAMESPACE_ALIASES[moduleName]) {
            const aliasedName = [NAMESPACE_ALIASES[moduleName], component].join('/');
            this.assertHasModule(aliasedName);
            return this.registry[aliasedName];
        }

        throw new Error(`Cannot resolve module '${moduleName}'`);
    }

    /**
     * Gets a generated view template from the registry, loading it from the server if needed
     *
     * @param {string} name - The template name
     * @returns a promise which resolves the exported module
     */
    async getTemplate(name) {
        return this.getModule(getViewModuleFullyQualifiedName(name), this.getResourceUrl({ view: name }));
    }

    /**
     * Gets a generated component from the registry, loading it from the server if needed
     *
     * @param {string} name - The component name
     * @returns a promise which resolves the exported module
     */
    async getComponent(name) {
        return this.getModule(name, this.getResourceUrl({ component: name }));
    }

    /**
     * Gets a module synchronously from the registry if it is present.
     *
     * @param {string} name - The module name
     * @returns the exported module if present in the registry, null if not
     */
    getModuleIfPresent(name) {
        return this.registry[name];
    }

    /**
     * Gets a module from the registry, loading it from the server if needed.
     *
     * @param {string} name - The module name
     * @returns a promise which resolves the exported module
     */
    async getModule(name, resourceUrl) {
        let moduleFromRegistry = this.registry[name];

        // return the module from the registry
        if (moduleFromRegistry) {
            return moduleFromRegistry;
        }

        // fetch the component from the server if it is not available yet
        return new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.type = "text/javascript";

            script.src = `${getBasePath()}${resourceUrl || this.getResourceUrl({ component: name })}`;
            script.onload = () => {
                script.onload = script.onerror = undefined;
                moduleFromRegistry = this.registry[name];
                if (moduleFromRegistry) {
                    resolve(moduleFromRegistry);
                } else {
                    reject(`Failed to load module: ${name}`);
                }
            };
            script.onerror = (error) => {
                script.onload = script.onerror = undefined;
                reject(error);
            };
            document.body.appendChild(script);
        });
    }

    setResourceUids(resourceUids) {
        this.resourceUids = resourceUids;
    }

    getResourceUrl({ component, view }) {
        const prefix = component ? "component" : "view";
        const resource = component || view;
        const mode = getMode();
        const { langLocale } = getLocale();
        const resourceName = `${prefix}://${resource}@${langLocale}`;
        const uid = this.resourceUids && this.resourceUids[resourceName];
        return getResourceUrl(resourceName, mode, uid);
    }

    hasModule(name) {
        const module = this.registry[name];
        return (typeof module !== 'undefined' && module !== null);
    }
}

// create an instance with bound methods so that they can be exported
const instance = autoBind(new ModuleRegistry());

export const { addModule, addModules, getModule, getComponent, getTemplate, getModuleIfPresent, hasModule, setResourceUids, define } = instance;

export default { addModule, addModules, getModule, getComponent, getTemplate, getModuleIfPresent, hasModule, setResourceUids, define };
