'use strict';

var nodePath = require('path');
var extend = require('raptor-util').extend;
var inherit = require('raptor-util').inherit;
var Dependency = require('./Dependency');
var CONTENT_TYPE_CSS = require('../content-types').CSS;
var CONTENT_TYPE_JS = require('../content-types').JS;
var ok = require('assert').ok;
var typePathRegExp = /^([A-Za-z0-9_\-]{2,})\s*:\s*(.+)$/; // Hack: {2,} is used because Windows file system paths start with "c:\"
var readStream = require('../util').readStream;
var AsyncValue = require('raptor-async/AsyncValue');
var equal = require('assert').equal;
var globNormalizer = require('./glob').normalizer;
var dependencyResource = require('./dependency-resource');
var logger = require('raptor-logging').logger(module);

function defaultGetLastModified(path, lassoContext, callback) {
    lassoContext.getFileLastModified(path, callback);
}

function createDefaultNormalizer(registry) {

    function parsePath(path) {
        var typePathMatches = typePathRegExp.exec(path);
        if (typePathMatches) {
            return {
                type: typePathMatches[1],
                path: typePathMatches[2]
            };
        } else {
            var type = registry.typeForPath(path);

            if (!type) {
                type = 'package';
            }

            return {
                type: type,
                path: path
            };
        }
    }

    return function(dependency) {
        if (typeof dependency === 'string') {
            dependency = parsePath(dependency);
        } else {
            dependency = Object.assign({}, dependency);

            // the dependency doesn't have a type so try to infer it from the path
            if (!dependency.type) {
                if (dependency.package) {
                    dependency.type = 'package';
                    dependency.path = dependency.package;
                    delete dependency.package;
                } else if (dependency.path) {
                    var parsed = parsePath(dependency.path);
                    dependency.type = parsed.type;
                    dependency.path = parsed.path;
                } else if (dependency.intersection) {
                    dependency.type = 'intersection';
                    dependency.dependencies = dependency.intersection;
                    delete dependency.intersection;
                } else if (dependency.dependencies) {
                    dependency.type = 'dependencies';
                }
            }
        }
        return dependency;
    };
}

function DependencyRegistry() {
    this.registeredTypes = {};
    this.extensions = {};
    this.requireExtensions = {};
    this._normalizers = [];
    this._finalNormalizers = [];

    this.addNormalizer(createDefaultNormalizer(this));

    this.registerDefaults();
    this.requireExtensions = {};

    this.requireExtensionNames = undefined;
}

DependencyRegistry.prototype = {
    __DependencyRegistry: true,

    registerDefaults: function() {
        this.registerStyleSheetType('css', require('./dependency-resource'));
        this.registerJavaScriptType('js', require('./dependency-resource'));
        this.registerJavaScriptType('comment', require('./dependency-comment'));
        this.registerPackageType('package', require('./dependency-package'));
        this.registerPackageType('intersection', require('./dependency-intersection'));
        this.registerPackageType('dependencies', require('./dependency-dependencies'));
        this.registerExtension('browser.json', 'package');
        this.registerExtension('optimizer.json', 'package');
    },

    typeForPath: function(path) {
        // Find the type from the longest matching file extension.
        // For example if we are trying to infer the type of "jquery-1.8.3.js" then we will try:
        // a) "8.3.js"
        // b) "3.js"
        // c) "js"
        path = nodePath.basename(path);

        var type = this.extensions[path];

        if (type) {
            // This is to handle the case where the extension
            // is the actual filename. For example: "browser.json"
            return type;
        }

        var dotPos = path.indexOf('.');
        if (dotPos === -1) {
            return null;
        }

        do {
            type = path.substring(dotPos + 1);
            if (this.extensions.hasOwnProperty(type)) {
                return this.extensions[type];
            }
            // move to the next dot position
            dotPos = path.indexOf('.', dotPos+1);
        }
        while(dotPos !== -1);

        var lastDot = path.lastIndexOf('.');
        return path.substring(lastDot+1);
    },

    addNormalizer: function(normalizerFunc) {
        ok(typeof normalizerFunc === 'function', 'function expected');
        this._normalizers.unshift(normalizerFunc);

        // Always run the glob normalizer first
        this._finalNormalizers = [globNormalizer].concat(this._normalizers);
    },
    registerType: function(type, mixins) {
        equal(typeof type, 'string', '"type" should be a string');
        equal(typeof mixins, 'object', '"mixins" should be a object');

        var isPackageDependency = mixins._packageDependency === true;

        var hasReadFunc = mixins.read;

        if (isPackageDependency && hasReadFunc) {
            throw new Error('Manifest dependency of type "' + type + '" is not expected to have a read() method.');
        }

        if (mixins.init) {
            mixins.doInit = mixins.init;
            delete mixins.init;
        }

        mixins = extend({}, mixins);

        var properties = mixins.properties || {};
        var childProperties = Object.create(Dependency.prototype.properties);
        extend(childProperties, properties);
        mixins.properties = childProperties;

        var calculateKey = mixins.calculateKey;
        if (calculateKey) {
            mixins.doCalculateKey = calculateKey;
            delete mixins.calculateKey;
        }

        var getLastModified = mixins.getLastModified || mixins.lastModified /* legacy */;
        if (getLastModified) {
            mixins.doGetLastModified = getLastModified;
            delete mixins.getLastModified;
            delete mixins.lastModified;
        }

        if (!isPackageDependency && mixins.read) {
            // Wrap the read method to ensure that it always returns a stream
            // instead of possibly using a callback
            var oldRead = mixins.read;
            delete mixins.read;

            mixins.doRead = function(lassoContext) {
                var _this = this;
                return readStream(function(callback) {
                    return oldRead.call(_this, lassoContext, callback);
                });
            };
        }


        var _this = this;

        function Ctor(dependencyConfig, dirname, filename) {
            this.__dependencyRegistry = _this;
            Dependency.call(this, dependencyConfig, dirname, filename);
        }

        inherit(Ctor, Dependency);

        extend(Ctor.prototype, mixins);

        this.registeredTypes[type] = Ctor;
    },

    registerRequireExtension: function(ext, options) {
        this.requireExtensionNames = undefined;
        equal(typeof ext, 'string', '"ext" should be a string');

        if (ext.charAt(0) === '.') {
            ext = ext.substring(1);
        }

        if (typeof options === 'function') {
            options = {
                read: options
            };
        }

        var createReadStream = options.createReadStream;
        if (!createReadStream) {
            if (!options.read) {
                throw new Error('Invalid require extension. "read(path, lassoContext, callback)" or createReadStream(path, lassoContext) is required');
            }

            var read = options.read;

            ok(typeof (options.read) === 'function', '"read" should be a function when registering a require extension');

            createReadStream = function(path, lassoContext) {
                return readStream(function(callback) {
                    return read(path, lassoContext, callback);
                });
            };
        } else {
            ok(typeof (options.createReadStream) === 'function', '"createReadStream" should be a function when registering a require extension');
        }


        this.requireExtensions[ext] = {
            getLastModified: options.getLastModified || defaultGetLastModified,
            createReadStream,
            object: options.object === true
        };
    },

    /**
     * In addition to registering a require extension using the "registerRequireExtension",
     * this method also registers a new dependency type with possibly additional properties.
     *
     * For example, if you just use "registerRequireExtension('foo', ...)", then only the following is supported:
     * - var foo = require('./hello.foo');
     * - "require: ./hello.foo"
     *
     * However, if you use registerRequireType with custom proeprties then all of the following are supported:
     * - var foo = require('./hello.foo');
     * - "require: ./hello.foo"
     * - "hello.foo",
     * - { "type": "foo", "path": "hello.foo", "hello": "world" }
     *
     * For an example, please see:
     * https://github.com/lasso-js/lasso-marko/blob/master/lib/lasso-marko-plugin.js
     *
     *
     *
     * dependency that can be required. Howev
     * @param {String} type   The extension/type to register
     * @param {Object} mixins [description]
     */
    registerRequireType: function(type, mixins) {
        equal(typeof type, 'string', '"type" should be a string');
        equal(typeof mixins, 'object', '"mixins" should be a object');

        mixins = extend({}, mixins);

        var userRead = mixins.read;
        var userCreateReadStream = mixins.createReadStream;

        var getLastModified = mixins.getLastModified;

        var object = mixins.object === true;

        delete mixins.read;
        delete mixins.createReadStream;
        delete mixins.getLastModified;
        delete mixins.object;

        let createReadStream = function(dependency, lassoContext) {
            return lassoContext.createReadStream(function(callback) {
                if (userCreateReadStream) {
                    return userCreateReadStream.call(dependency, lassoContext);
                } else {
                    return userRead.call(dependency, lassoContext, callback);
                }
            });
        };

        if (!mixins.getSourceFile) {
            mixins.getSourceFile = function() {
                return this.path;
            };
        }

        mixins.getDependencies = function(lassoContext, callback) {
            var path = this.path;
            var self = this;
            var lastModifiedAsyncValue = null;
            callback(null, [
                {
                    type: 'require',
                    path: path,
                    requireHandler: {
                        createReadStream: () => {
                            return createReadStream(self, lassoContext);
                        },
                        getLastModified: (callback) => {
                            var promise;

                            if (!callback) {
                                promise = new Promise((resolve, reject) => {
                                    callback = function(err, lastModified) {
                                        if (err) {
                                            return reject(err);
                                        }

                                        resolve(lastModified);
                                    };
                                });
                            }

                            if (!lastModifiedAsyncValue) {
                                lastModifiedAsyncValue = new AsyncValue();
                                if (getLastModified) {
                                    getLastModified.call(self, lassoContext, function(err, lastModified) {
                                        if (err) {
                                            return lastModifiedAsyncValue.reject(err);
                                        }

                                        lastModifiedAsyncValue.resolve(lastModified);
                                    });
                                } else {
                                    lastModifiedAsyncValue.resolve(-1);
                                }
                            }

                            lastModifiedAsyncValue.done(callback);

                            return promise;
                        },
                        object: object
                    }
                }
            ]);
        };

        this.registerPackageType(type, mixins);

        this.registerRequireExtension(type, {
            object: object,

            read: function(path, lassoContext) {
                var self = {
                    path: path
                };

                return createReadStream(self, lassoContext);
            },
            getLastModified: function(path, lassoContext, callback) {
                if (getLastModified) {
                    var self = {
                        path: path
                    };
                    return getLastModified.call(self, lassoContext, callback);
                } else {
                    return callback(null, -1);
                }
            }
        });
    },

    getRequireExtensionNames() {
        if (this.requireExtensionNames === undefined) {

            var extensionsLookup = {};

            let nodeRequireExtensions = require.extensions;
            for (let ext in nodeRequireExtensions) {
                if (ext !== '.node') {
                    extensionsLookup[ext] = true;
                }
            }

            for (let ext in this.requireExtensions) {
                if (ext.charAt(0) !== '.') {
                    ext = '.' + ext;
                }
                extensionsLookup[ext] = true;
            }

            this.requireExtensionNames = Object.keys(extensionsLookup);
        }
        return this.requireExtensionNames;
    },

    getRequireHandler: function(path, lassoContext) {
        ok(path, '"path" is required');
        ok(lassoContext, '"lassoContext" is required');

        ok(typeof path === 'string', '"path" should be a string');
        ok(typeof lassoContext === 'object', '"lassoContext" should be an object');

        var basename = nodePath.basename(path);
        var lastDot = basename.lastIndexOf('.');
        var ext;
        if (lastDot === -1) {
            return null;
        }

        ext = basename.substring(lastDot+1);

        var requireExt = this.requireExtensions[ext];
        if (!requireExt) {
            return null;
        }

        var readStream = requireExt.createReadStream;
        var getLastModified = requireExt.getLastModified;

        var lastModifiedAsyncValue = null;

        return {
            object: requireExt.object === true,

            /** deprecated. Use createCreateStream instead **/
            reader: function() {
                return readStream(path, lassoContext);
            },

            createReadStream: function() {
                return readStream(path, lassoContext);
            },

            getLastModified: function(callback) {
                var promise;

                if (!callback) {
                    promise = new Promise((resolve, reject) => {
                        callback = function(err, lastModified) {
                            if (err) {
                                return reject(err);
                            }

                            resolve(lastModified);
                        };
                    });
                }

                if (!lastModifiedAsyncValue) {
                    lastModifiedAsyncValue = new AsyncValue();

                    getLastModified(path, lassoContext, function(err, lastModified) {
                        if (err) {
                            return lastModifiedAsyncValue.reject(err);
                        }

                        lastModifiedAsyncValue.resolve(lastModified);
                    });
                }

                lastModifiedAsyncValue.done(callback);

                return promise;
            }
        };
    },

    registerJavaScriptType: function(type, mixins) {
        equal(typeof type, 'string', '"type" should be a string');
        equal(typeof mixins, 'object', '"mixins" should be a object');
        mixins.contentType = CONTENT_TYPE_JS;
        this.registerType(type, mixins);
    },

    registerStyleSheetType: function(type, mixins) {
        equal(typeof type, 'string', '"type" should be a string');
        equal(typeof mixins, 'object', '"mixins" should be a object');
        mixins.contentType = CONTENT_TYPE_CSS;
        this.registerType(type, mixins);
    },

    registerPackageType: function(type, mixins) {
        equal(typeof type, 'string', '"type" should be a string');
        equal(typeof mixins, 'object', '"mixins" should be a object');
        mixins._packageDependency = true;
        this.registerType(type, mixins);
    },

    registerExtension: function(extension, type) {
        equal(typeof extension, 'string', '"extension" should be a string');
        equal(typeof type, 'string', '"type" should be a string');
        this.extensions[extension] = type;
    },

    getType: function(type) {
        return this.registeredTypes[type];
    },

    createDependency: function(config, dirname, filename) {
        ok(config, '"config" is required');
        ok(dirname, '"dirname" is required');
        equal(typeof config, 'object', 'Invalid dependency: ' + require('util').inspect(config));

        var type = config.type;
        var Ctor = this.registeredTypes[type];
        if (!Ctor) {
            throw new Error('Dependency of type "' + type + '" is not supported. (dependency=' + require('util').inspect(config) + ', package="' + filename + '"). Registered types:\n' + Object.keys(this.registeredTypes).join(', '));
        }

        return new Ctor(config, dirname, filename);
    },

    normalizeDependencies: function(dependencies, dirname, filename, callback) {
        ok(typeof callback === 'function', 'callback function expected ');

        logger.debug('normalizeDependencies()  BEGIN: ', dependencies, 'count:', dependencies.length);

        if (dependencies.length === 0) {
            return callback(null, dependencies);
        }

        var i=0;
        var j=0;

        dependencies = dependencies.concat([]);

        var normalizers = this._finalNormalizers;
        var normalizerCount = normalizers.length;

        var context = {
            dirname: dirname,
            filename: filename
        };

        var handleNormalizedDependency = (normalizedDependency) => {
            if (normalizedDependency) {
                if (Array.isArray(normalizedDependency)) {
                    dependencies.splice.apply(dependencies, [i, 1 /* remove one */].concat(normalizedDependency));
                    j=0;
                    // Continue at the same dependency index, but restart normalizing at the beginning
                    return;
                } else {
                    dependencies[i] = normalizedDependency;

                }
            }

            j++;

            return normalizedDependency;
        };

        var go;

        var asyncNormalizeCallback = (err, d) => {
            if (err) {
                return callback(err);
            }
            handleNormalizedDependency(d);
            go();
        };

        go = () => {
            while(i<dependencies.length) {
                let dependency = dependencies[i];
                while(j<normalizerCount) {
                    let normalizeFunc = normalizers[j];
                    if (normalizeFunc.length === 3) {
                        // Asynchronous normalizer
                        normalizeFunc(dependency, context, asyncNormalizeCallback);
                        // Stop looping and we will pick up where we left off when
                        // the async normalizer finishes
                        return;
                    } else {
                        // Synchronous normalizer
                        dependency = handleNormalizedDependency(normalizeFunc(dependency, context)) || dependency;
                    }
                }

                j=0; // Restart with the first normalizer for the next dependency

                if (!dependency.__Dependency) {
                    // Convert the dependency objet to an actual Dependency instance
                    dependency = this.createDependency(dependency, dirname, filename);
                }

                dependencies[i] = dependency;
                i++;
            }

            logger.debug('normalizeDependencies()  DONE!');
            callback(null, dependencies);
        };

        go();
    },

    /**
     * This method is used to create a new JavaScript or CSS
     * type that allows the code to be transformed using a custom
     * transform function. This was introduced because we wanted to
     * be able to easily use the babel transpiler on individual
     * JS dependencies without registering a global transform.
     */
    createResourceTransformType: function(transformFunc) {
        var transformType = extend({}, dependencyResource);
        extend(transformType, {
            isExternalResource: function() {
                return false;
            },

            read: function(context, callback) {
                // console.log(module.id, new Error().stack);
                var stream = dependencyResource.read.call(this, {}, function(err, code) {
                    if (err) {
                        return callback(err);
                    }

                    transformFunc(code, callback);
                });
                if (stream) {
                    var code = '';
                    stream
                        .on('data', function(data) {
                            code += data;
                        })
                        .on('end', function() {
                            transformFunc(code, callback);
                        });
                }
            }
        });

        return transformType;
    }

};

module.exports = DependencyRegistry;
