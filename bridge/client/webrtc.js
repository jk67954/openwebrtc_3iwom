(function () {
var originToken = "1571cfa44fc0b976797";
/*
 * Copyright (C) 2009-2015 Ericsson AB. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer
 *    in the documentation and/or other materials provided with the
 *    distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// A lightweight JavaScript-to-JavaScript JSON RPC utility.
//
// msgLink   : An object supporting the HTML5 Web Messaging API
//             (http://dev.w3.org/html5/postmsg) used for communicating between
//             the RPC endpoints.
// options   : An object containing options used to configure this RPC endpoint.
//             Supported options:
//             - unrestricted
//                 Disables the security feature that requires this enpoint to
//                 export functions before the other endpoint can call them.
//             - noRemoteExceptions
//                 Prevents this endpoint from throwing exceptions returned
//                 from the other endpoint as a result of a call.
//             - scope
//                 The scope from which the other endpoint can import functions.
//

"use strict";

var JsonRpc = function (msgLink, optionsOrRestricted) {
    var thisObj = this;
    var id = String(Math.random()).substr(2);
    var count = 0;
    var callbacks = {};
    var exports = [];
    var referencedObjects = {};
    var refObjects = {};
    var onerror;

    var restricted = !!optionsOrRestricted;
    var noRemoteExceptions = false;
    var scope;

    if (typeof optionsOrRestricted == "object") {
        var options = optionsOrRestricted;

        restricted = !options.unrestricted;
        noRemoteExceptions = !!options.noRemoteExceptions;
        scope = options.scope ? options.scope : self;
    } else
        scope = self;

    // Setter replaces the message link provided when constructing the object.
    // This enables an RPC to connect to a new endpoint while keeping internal
    // data such as imported and exported functions.
    Object.defineProperty(this, "messageLink", {
        "get": function () { return msgLink; },
        "set": function (ml) {
            msgLink = ml;
            msgLink.onmessage = onmessage;
        }
    });

    Object.defineProperty(this, "scope", {
        "get": function () { return scope; },
        "set": function (s) { scope = s; }
    });

    Object.defineProperty(this, "onerror", {
        "get": function () { return onerror; },
        "set": function (cb) { onerror = cb instanceof Function ? cb : null; },
        "enumerable": true
    });

    // Import one or several functions from the other side to make them callable
    // on this RPC object. The functions can be imported regardless if they
    // exist on the other side or not.
    // args: [fnames | fname1...fnamen]
    this.importFunctions = function () {
        var args = arguments[0] instanceof Array ? arguments[0] : arguments;
        internalImport(this, args);
    };

    // Export one or several functions on this RPC object. If this RPC object is
    // restricted, a function needs to be exported in order to make it callable
    // from the other side.
    // args: [functions | function1...functionn]
    this.exportFunctions = function () {
        var args = arguments[0] instanceof Array ? arguments[0] : arguments;
        for (var i = 0; i < args.length; i++) {
            for (var j = 0; j < exports.length; j++) {
                if (exports[j] === args[i])
                    break;
            }
            if (j == exports.length)
                exports.push(args[i]);
        }
    };

    // Remove one or several functions from the list of exported in order to
    // make them non-callable from the other side.
    // args: [functions | function1...functionn]
    this.unexportFunctions = function () {
        var args = arguments[0] instanceof Array ? arguments[0] : arguments;
        for (var i = 0; i < args.length; i++) {
            for (var j = 0; j < exports.length; j++) {
                if (exports[j] === args[i]) {
                    exports.splice(j, 1);
                    break;
                }
            }
        }
    };

    // Create a reference object which can be sent to the other side as an
    // argument to an RPC call. Calling an exported function on the reference
    // object results in calling the corresponding function on the source
    // object. The exported functions must be properties on the source objects.
    // args: srcObj [, fpnames | fpname1...fpnamen]
    this.createObjectRef = function () {
        var srcObj = arguments[0];
        var refObj = {
            "__refId": id + "_" + count++,
            "__methods": []
        };
        var i = 1;
        var args = arguments[1] instanceof Array ? arguments[i--] : arguments;

        // FIXME: need to handle circular references (e.g. double linked list)
        for (; i < args.length; i++)
            if (srcObj[args[i]] instanceof Function)
                refObj.__methods.push(args[i]);
        referencedObjects[refObj.__refId] = srcObj;
        return refObj;
    };

    // Remove the reference object (i.e. the link between the reference and the
    // source object).
    this.removeObjectRef = function (obj) {
        var refId;
        if (obj.__refId)
            refId = obj.__refId;
        else for (var pname in referencedObjects) {
            if (referencedObjects[pname] === obj) {
                refId = pname;
                break;
            }
        }
        if (refId)
            delete referencedObjects[refId];
    };

    // -----------------------------------------------------------------------------

    function internalImport(destObj, names, refObjId) {
        for (var i = 0; i < names.length; i++) {
            var nparts = names[i].split(".");
            var targetObj = destObj;
            for (var j = 0; j < nparts.length-1; j++) {
                var n = nparts[j];
                if (!targetObj[n])
                    targetObj[n] = {};
                targetObj = targetObj[n];
            }
            targetObj[nparts[nparts.length-1]] = (function (name) {
                return function () {
                    var requestId = null;
                    var params = [];
                    params.push.apply(params, arguments);
                    if (params[params.length-1] instanceof Function) {
                        requestId = id + "_" + count++;
                        callbacks[requestId] = params.pop();
                    }
                    for (var j = 0; j < params.length; j++) {
                        var p = params[j];
                        if (p instanceof ArrayBuffer || ArrayBuffer.isView(p))
                            params[j] = encodeArrayBufferArgument(p);
                        else
                            substituteRefObject(params, j);
                    }

                    var request = {
                        "id": requestId,
                        "method": name,
                        "params": params
                    };
                    if (refObjId)
                        request.__refId = refObjId;
                    msgLink.postMessage(JSON.stringify(request));
                };
            })(names[i]);
        }
    }

    function encodeArrayBufferArgument(buffer) {
        return {
            "__argumentType": buffer.constructor.name,
            "base64": btoa(Array.prototype.map.call(new Uint8Array(buffer),
                function (byte) {
                    return String.fromCharCode(byte);
                }).join(""))
        };
    }

    function decodeArrayBufferArgument(obj) {
        var data = atob(obj.base64 || "");
        var arr = new Uint8Array(data.length);
        for (var i = 0; i < data.length; i++)
            arr[i] = data.charCodeAt(i);

        var constructor = self[obj.__argumentType];
        if (constructor && constructor.BYTES_PER_ELEMENT)
            return new constructor(arr);

        return arr.buffer;
    }

    function substituteRefObject(parent, pname) {
        if (!parent[pname] || typeof parent[pname] != "object")
            return;

        var obj = parent[pname];
        for (var refId in refObjects) {
            if (refObjects[refId] === obj) {
                parent[pname] = { "__refId": refId };
                return;
            }
        }

        for (var p in obj) {
            if (obj.hasOwnProperty(p))
                substituteRefObject(obj, p);
        }
    }

    function substituteReferencedObject(parent, pname) {
        if (!parent[pname] || typeof parent[pname] != "object")
            return;

        var obj = parent[pname];
        if (obj.__refId && referencedObjects[obj.__refId]) {
            parent[pname] = referencedObjects[obj.__refId];
            return;
        }

        for (var p in obj) {
            if (obj.hasOwnProperty(p))
                substituteReferencedObject(obj, p);
        }
    }

    function prepareRefObj(obj) {
        if (!obj)
            return;
        try { // give up if __refId can't be read from obj
            obj.__refId;
        } catch (e) {
            return;
        }
        if (obj.__refId) {
            internalImport(obj, obj.__methods, obj.__refId);
            refObjects[obj.__refId] = obj;
            delete obj.__methods;
            delete obj.__refId;
            return;
        }
        if (typeof obj == "object") {
            for (var pname in obj) {
                if (obj.hasOwnProperty(pname))
                    prepareRefObj(obj[pname]);
            }
        }
    }

    function onmessage(evt) {
        var msg = JSON.parse(evt.data);
        if (msg.method) {
            var nparts = msg.method.split(".");
            var obj = msg.__refId ? referencedObjects[msg.__refId] : scope;
            if (!obj)
                throw "referenced object not found";
            for (var i = 0; i < nparts.length-1; i++) {
                obj = obj[nparts[i]];
                if (!obj) {
                    obj = {};
                    break;
                }
            }
            var f = obj[nparts[nparts.length-1]];
            if (restricted) {
                for (var j = 0; j < exports.length; j++) {
                    if (f === exports[j])
                        break;
                }
                if (j == exports.length)
                    f = "not.exported";
            }
            var response = {};
            response.id = msg.id;
            if (f instanceof Function) {
                try {
                    for (var i = 0; i < msg.params.length; i++) {
                        var p = msg.params[i];
                        if (p && p.__argumentType)
                            msg.params[i] = decodeArrayBufferArgument(p);
                        else
                            substituteReferencedObject(msg.params, i);
                    }
                    prepareRefObj(msg.params);
                    //var functionScope = !msg.__refId ? thisObj : obj; // FIXME: !!
                    var functionScope = !msg.__refId && obj == scope ? thisObj : obj;
                    response.result = f.apply(functionScope, msg.params);
                    var resultType = response.__resultType = typeof response.result;
                    if (resultType == "function" || resultType == "undefined")
                        response.result = null;
                }
                catch (e) {
                    response.error = msg.method + ": " + (e.message || e);
                }
            }
            else if (f == "not.exported")
                response.error = msg.method + ": restricted mode and not exported";
            else
                response.error = msg.method + ": not a function";

            if (msg.id != null || response.error)
                msgLink.postMessage(JSON.stringify(response));
        }
        else if (msg.hasOwnProperty("result")) {
            var cb = callbacks[msg.id];
            if (cb) {
                delete callbacks[msg.id];
                if (msg.__resultType == "undefined")
                    delete msg.result;
                else if (msg.__resultType == "function")
                    msg.result = function () { throw "can't call remote function"; };
                prepareRefObj(msg.result);
                cb(msg.result);
            }
        }
        else if (msg.error) {
            if (!noRemoteExceptions)
                throw msg.error;
            else if (onerror)
                onerror({
                    "type": "error",
                    "message": msg.error,
                    "filename": "",
                    "lineno": 0,
                    "colno": 0,
                    "error": null
                });
        }
    }
    msgLink.onmessage = onmessage;
};

// for node.js
if (typeof exports !== "undefined") {
    global.btoa = function (s) {
        return new Buffer(s).toString("base64");
    };
    global.atob = function (s) {
        return new Buffer(s, "base64").toString();
    };
    module.exports = JsonRpc;
}
/*
 * Copyright (C) 2014-2015 Ericsson AB. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer
 *    in the documentation and/or other materials provided with the
 *    distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

"use strict";

var domObject = (function () {

    function createAttributeDescriptor(name, attributes) {
        return {
            "get": function () {
                var attribute = attributes[name];
                return typeof attribute == "function" ? attribute() : attribute;
            },
            "enumerable": true
        };
    }

    return {
        "addReadOnlyAttributes": function (target, attributes) {
            for (var name in attributes)
                Object.defineProperty(target, name, createAttributeDescriptor(name, attributes));
        },

        "addConstants": function (target, constants) {
            for (var name in constants)
                Object.defineProperty(target, name, {
                    "value": constants[name],
                    "enumerable": true
                });
        }
    };
})();

function EventTarget(attributes) {
    var _this = this;
    var listenersMap = {};

    if (attributes)
        addEventListenerAttributes(this, attributes);

    this.addEventListener = function (type, listener, useCapture) {
        if (typeof(listener) != "function")
            throw new TypeError("listener argument (" + listener + ") is not a function");
        var listeners = listenersMap[type];
        if (!listeners)
            listeners = listenersMap[type] = [];

        if (listeners.indexOf(listener) < 0)
            listeners.push(listener);
    };

    this.removeEventListener = function (type, listener, useCapture) {
        var listeners = listenersMap[type];
        if (!listeners)
            return;

        var i = listeners.indexOf(listener);
        if (i >= 0)
            listeners.splice(i, 1);
    };

    this.dispatchEvent = function (evt) {
        var listeners = [];

        var attributeListener = _this["on" + evt.type];
        if (attributeListener)
            listeners.push(attributeListener);

        if (listenersMap[evt.type])
            Array.prototype.push.apply(listeners, listenersMap[evt.type]);

        var errors = [];
        var result = true;
        listeners.forEach(function (listener) {
            try {
                result = !(listener(evt) === false) && result;
            } catch (e) {
                errors.push(e);
            }
        });

        errors.forEach(function (e) {
            setTimeout(function () {
                throw e;
            });
        });

        return result;
    };

    function addEventListenerAttributes(target, attributes) {
        for (var name in attributes)
            Object.defineProperty(target, name, createEventListenerDescriptor(name, attributes));
    }

    function createEventListenerDescriptor(name, attributes) {
        return {
            "get": function () { return attributes[name]; },
            "set": function (cb) { attributes[name] = (typeof(cb) == "function") ? cb : null; },
            "enumerable": true
        };
    }
}

function checkDictionary(name, dict, typeMap) {
    for (var memberName in dict) {
        if (!dict.hasOwnProperty(memberName) || !typeMap.hasOwnProperty(memberName))
            continue;

        var message = name + ": Dictionary member " + memberName;
        checkType(message, dict[memberName], typeMap[memberName]);
    }
}

function checkArguments(name, argsTypeTemplate, numRequired, args) {
    var error = getArgumentsError(argsTypeTemplate, numRequired, args);
    if (error)
        throw createError("TypeError", name + ": " + error);
}

function checkType(name, value, typeTemplate) {
    var error = getTypeError(name, value, typeTemplate);
    if (error)
        throw createError("TypeError", name + ": " + error);
}

function getArgumentsError(argsTypeTemplate, numRequired, args) {
    if (args.length < numRequired)
        return "Too few arguments (got " + args.length + " expected " + numRequired + ")";

    var typeTemplates = argsTypeTemplate.split(/\s*,\s*/);

    for (var i = 0; i < args.length && i < typeTemplates.length; i++) {
        var prefix = "Argument " + (i + 1);
        var error = getTypeError(prefix, args[i], typeTemplates[i]);
        if (error)
            return error;
    }
    return null;
}

function getTypeError(prefix, value, typeTemplate) {
    var expectedTypes = typeTemplate.split(/\s*\|\s*/);
    if (!canConvert(value, expectedTypes))
        return prefix + " is of wrong type (expected " + expectedTypes.join(" or ") + ")";
    return null;
}

function canConvert(value, expectedTypes) {
    var type = typeof value;
    for (var i = 0; i < expectedTypes.length; i++) {
        var expectedType = expectedTypes[i];
        if (expectedType == "string" || expectedType == "boolean")
            return true; // type conversion will never throw
        if (expectedType == "number") {
            var asNumber = +value;
            if (!isNaN(asNumber) && asNumber != -Infinity && asNumber != Infinity)
                return true;
        }
        if (expectedType == "dictionary") { // object, undefined and null can be converted
            if (type == "object" || type == "undefined" || type == "null")
                return true;
        }
        if (type == "object") {
            if (expectedType == "object")
                return true;
            // could be a specific object type or host object (e.g. Array)
            var constructor = self[expectedType];
            if (constructor && value instanceof constructor)
                return true;
        }
        if (type == expectedType && expectedType == "function")
            return true;
    }
    return false;
}

function getDictionaryMember(dict, name, type, defaultValue) {
    if (!dict.hasOwnProperty(name) || dict[name] == null)
        return defaultValue;
    if (type == "string")
        return String(dict[name]);
    if (type == "boolean")
        return !!dict[name];
    if (type == "number")
        return +dict[name];
}

function randomNumber(bits) {
    return Math.floor(Math.random() * Math.pow(2, bits));
}

function randomString(length) {
    var randomValues = new Uint8Array(Math.ceil(length * 3 / 4));
    crypto.getRandomValues(randomValues);
    return btoa(String.fromCharCode.apply(null, randomValues)).substr(0, length);
}

function createError(name, message) {
    var constructor = self[name] || self.Error;
    var error = new constructor(message);
    error.name = name;
    return error;
}

function entityReplace(str) {
    return escape(str).replace(/%([0-9A-F]{2})/g, function (match) {
        return "&#" + parseInt(match.substr(1), 16) + ";"
    });
}
/*
 * Copyright (C) 2014-2015 Ericsson AB. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer
 *    in the documentation and/or other materials provided with the
 *    distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

"use strict";

if (typeof(SDP) == "undefined")
    var SDP = {};

(function () {
    var regexps = {
        "vline": "^v=([\\d]+).*$",
        "oline": "^o=([\\w\\-@\\.]+) ([\\d]+) ([\\d]+) IN (IP[46]) ([\\d\\.a-f\\:]+).*$",
        "sline": "^s=(.*)$",
        "tline": "^t=([\\d]+) ([\\d]+).*$",
        "cline": "^c=IN (IP[46]) ([\\d\\.a-f\\:]+).*$",
        "msidsemantic": "^a=msid-semantic: *WMS .*$",
        "mblock": "^m=(audio|video|application) ([\\d]+) ([A-Z/]+)([\\d ]*)$\\r?\\n",
        "mode": "^a=(sendrecv|sendonly|recvonly|inactive).*$",
        "rtpmap": "^a=rtpmap:${type} ([\\w\\-]+)/([\\d]+)/?([\\d]+)?.*$",
        "fmtp": "^a=fmtp:${type} ([\\w\\-=; ]+).*$",
        "param": "([\\w\\-]+)=([\\w\\-]+);?",
        "nack": "^a=rtcp-fb:${type} nack$",
        "nackpli": "^a=rtcp-fb:${type} nack pli$",
        "ccmfir": "^a=rtcp-fb:${type} ccm fir$",
        "ericscream": "^a=rtcp-fb:${type} ericscream$",
        "rtcp": "^a=rtcp:([\\d]+)( IN (IP[46]) ([\\d\\.a-f\\:]+))?.*$",
        "rtcpmux": "^a=rtcp-mux.*$",
        "cname": "^a=ssrc:(\\d+) cname:([\\w+/\\-@\\.\\{\\}]+).*$",
        "msid": "^a=(ssrc:\\d+ )?msid:([\\w+/\\-=]+) +([\\w+/\\-=]+).*$",
        "ufrag": "^a=ice-ufrag:([\\w+/]*).*$",
        "pwd": "^a=ice-pwd:([\\w+/]*).*$",
        "iceoptions": "^a=ice-options:(.*$)",
        "trickle": "\\btrickle\\b.*$",
        "candidate": "^a=candidate:(\\d+) (\\d) (UDP|TCP) ([\\d\\.]*) ([\\d\\.a-f\\:]*) (\\d*)" +
            " typ ([a-z]*)( raddr ([\\d\\.a-f\\:]*) rport (\\d*))?" +
            "( tcptype (active|passive|so))?.*$",
        "fingerprint": "^a=fingerprint:(sha-1|sha-256) ([A-Fa-f\\d\:]+).*$",
        "setup": "^a=setup:(actpass|active|passive).*$",
        "sctpmap": "^a=sctpmap:${port} ([\\w\\-]+)( [\\d]+)?.*$"
    };

    var templates = {
        "sdp":
            "v=${version}\r\n" +
            "o=${username} ${sessionId} ${sessionVersion} ${netType} ${addressType} ${address}\r\n" +
            "s=${sessionName}\r\n" +
            "t=${startTime} ${stopTime}\r\n" +
            "${msidsemanticLine}",

        "msidsemantic": "a=msid-semantic:WMS ${mediaStreamIds}\r\n",

        "mblock":
            "m=${type} ${port} ${protocol} ${fmt}\r\n" +
            "c=${netType} ${addressType} ${address}\r\n" +
            "${rtcpLine}" +
            "${rtcpMuxLine}" +
            "a=${mode}\r\n" +
            "${rtpMapLines}" +
            "${fmtpLines}" +
            "${nackLines}" +
            "${nackpliLines}" +
            "${ccmfirLines}" +
            "${ericScreamLines}" +
            "${cnameLines}" +
            "${msidLines}" +
            "${iceCredentialLines}" +
            "${iceOptionLine}" +
            "${candidateLines}" +
            "${dtlsFingerprintLine}" +
            "${dtlsSetupLine}" +
            "${sctpmapLine}",

        "rtcp": "a=rtcp:${port}${[ ]netType}${[ ]addressType}${[ ]address}\r\n",
        "rtcpMux": "a=rtcp-mux\r\n",

        "rtpMap": "a=rtpmap:${type} ${encodingName}/${clockRate}${[/]channels}\r\n",
        "fmtp": "a=fmtp:${type} ${parameters}\r\n",
        "nack": "a=rtcp-fb:${type} nack\r\n",
        "nackpli": "a=rtcp-fb:${type} nack pli\r\n",
        "ccmfir": "a=rtcp-fb:${type} ccm fir\r\n",
        "ericscream": "a=rtcp-fb:${type} ericscream\r\n",

        "cname": "a=ssrc:${ssrc} cname:${cname}\r\n",
        "msid": "a=msid:${mediaStreamId} ${mediaStreamTrackId}\r\n",

        "iceCredentials":
            "a=ice-ufrag:${ufrag}\r\n" +
            "a=ice-pwd:${password}\r\n",

        "iceOptionsTrickle":
            "a=ice-options:trickle\r\n",

        "candidate":
            "a=candidate:${foundation} ${componentId} ${transport} ${priority} ${address} ${port}" +
            " typ ${type}${[ raddr ]relatedAddress}${[ rport ]relatedPort}${[ tcptype ]tcpType}\r\n",

        "dtlsFingerprint": "a=fingerprint:${fingerprintHashFunction} ${fingerprint}\r\n",
        "dtlsSetup": "a=setup:${setup}\r\n",

        "sctpmap": "a=sctpmap:${port} ${app}${[ ]streams}\r\n"
    };

    function match(data, pattern, flags, alt) {
        var r = new RegExp(pattern, flags);
        return data.match(r) || alt && alt.match(r) || null;
    }

    function addDefaults(obj, defaults) {
        for (var p in defaults) {
            if (!defaults.hasOwnProperty(p))
                continue;
            if (typeof(obj[p]) == "undefined")
                obj[p] = defaults[p];
        }
    }

    function fillTemplate(template, info) {
        var text = template;
        for (var p in info) {
            if (!info.hasOwnProperty(p))
                continue;
            var r = new RegExp("\\${(\\[[^\\]]+\\])?" + p + "(\\[[^\\]]+\\])?}");
            text = text.replace(r, function (_, prefix, suffix) {
                if (!info[p] && info[p] != 0)
                    return "";
                prefix = prefix ? prefix.substr(1, prefix.length - 2) : "";
                suffix = suffix ? suffix.substr(1, suffix.length - 2) : "";
                return prefix + info[p] + suffix;
            });
        }
        return text;
    }

    SDP.parse = function (sdpText) {
        sdpText = new String(sdpText);
        var sdpObj = {};
        var parts = sdpText.split(new RegExp(regexps.mblock, "m")) || [sdpText];
        var sblock = parts.shift();
        var version = parseInt((match(sblock, regexps.vline, "m") || [])[1]);
        if (!isNaN(version))
            sdpObj.version = version;
        var originator = match(sblock, regexps.oline, "m");;
        if (originator) {
            sdpObj.originator = {
                "username": originator[1],
                "sessionId": originator[2],
                "sessionVersion": parseInt(originator[3]),
                "netType": "IN",
                "addressType": originator[4],
                "address": originator[5]
            };
        }
        var sessionName = match(sblock, regexps.sline, "m");
        if (sessionName)
            sdpObj.sessionName = sessionName[1];
        var sessionTime = match(sblock, regexps.tline, "m");
        if (sessionTime) {
            sdpObj.startTime = parseInt(sessionTime[1]);
            sdpObj.stopTime = parseInt(sessionTime[2]);
        }
        var hasMediaStreamId = !!match(sblock, regexps.msidsemantic, "m");
        sdpObj.mediaDescriptions = [];

        for (var i = 0; i < parts.length; i += 5) {
            var mediaDescription = {
                "type": parts[i],
                "port": parseInt(parts[i + 1]),
                "protocol": parts[i + 2],
            };
            var fmt = parts[i + 3].replace(/^[\s\uFEFF\xA0]+/, '')
                .split(/ +/)
                .map(function (x) {
                    return parseInt(x);
                });
            var mblock = parts[i + 4];

            var connection = match(mblock, regexps.cline, "m", sblock);
            if (connection) {
                mediaDescription.netType = "IN";
                mediaDescription.addressType = connection[1];
                mediaDescription.address = connection[2];
            }
            var mode = match(mblock, regexps.mode, "m", sblock);
            if (mode)
                mediaDescription.mode = mode[1];

            var payloadTypes = [];
            if (match(mediaDescription.protocol, "(UDP/TLS)?RTP/S?AVPF?")) {
                mediaDescription.payloads = [];
                payloadTypes = fmt;
            }
            payloadTypes.forEach(function (payloadType) {
                var payload = { "type": payloadType };
                var rtpmapLine = fillTemplate(regexps.rtpmap, payload);
                var rtpmap = match(mblock, rtpmapLine, "m");
                if (rtpmap) {
                    payload.encodingName = rtpmap[1];
                    payload.clockRate = parseInt(rtpmap[2]);
                    if (mediaDescription.type == "audio")
                        payload.channels = parseInt(rtpmap[3]) || 1;
                    else if (mediaDescription.type == "video") {
                        var nackLine = fillTemplate(regexps.nack, payload);
                        payload.nack = !!match(mblock, nackLine, "m");
                        var nackpliLine = fillTemplate(regexps.nackpli, payload);
                        payload.nackpli = !!match(mblock, nackpliLine, "m");
                        var ccmfirLine = fillTemplate(regexps.ccmfir, payload);
                        payload.ccmfir = !!match(mblock, ccmfirLine, "m");
                        var ericScreamLine = fillTemplate(regexps.ericscream, payload);
                        payload.ericscream = !!match(mblock, ericScreamLine, "m");
                    }
                } else if (payloadType == 0 || payloadType == 8) {
                    payload.encodingName = payloadType == 8 ? "PCMA" : "PCMU";
                    payload.clockRate = 8000;
                    payload.channels = 1;
                }
                var fmtpLine = fillTemplate(regexps.fmtp, payload);
                var fmtp = match(mblock, fmtpLine, "m");
                if (fmtp) {
                    payload.parameters = {};
                    fmtp[1].replace(new RegExp(regexps.param, "g"),
                        function(_, key, value) {
                            key = key.replace(/-([a-z])/g, function (_, c) {
                                return c.toUpperCase();
                            });
                            payload.parameters[key] = isNaN(+value) ? value : +value;
                    });
                }
                mediaDescription.payloads.push(payload);
            });

            var rtcp = match(mblock, regexps.rtcp, "m");
            if (rtcp) {
                mediaDescription.rtcp = {
                    "netType": "IN",
                    "port": parseInt(rtcp[1])
                };
                if (rtcp[2]) {
                    mediaDescription.rtcp.addressType = rtcp[3];
                    mediaDescription.rtcp.address = rtcp[4];
                }
            }
            var rtcpmux = match(mblock, regexps.rtcpmux, "m", sblock);
            if (rtcpmux) {
                if (!mediaDescription.rtcp)
                    mediaDescription.rtcp = {};
                mediaDescription.rtcp.mux = true;
            }

            var cnameLines = match(mblock, regexps.cname, "mg");
            if (cnameLines) {
                mediaDescription.ssrcs = [];
                cnameLines.forEach(function (line) {
                    var cname = match(line, regexps.cname, "m");
                    mediaDescription.ssrcs.push(parseInt(cname[1]));
                    if (!mediaDescription.cname)
                        mediaDescription.cname = cname[2];
                });
            }

            if (hasMediaStreamId) {
                var msid = match(mblock, regexps.msid, "m");
                if (msid) {
                    mediaDescription.mediaStreamId = msid[2];
                    mediaDescription.mediaStreamTrackId = msid[3];
                }
            }

            var ufrag = match(mblock, regexps.ufrag, "m", sblock);
            var pwd = match(mblock, regexps.pwd, "m", sblock);
            if (ufrag && pwd) {
                mediaDescription.ice = {
                    "ufrag": ufrag[1],
                    "password": pwd[1],
                    "iceOptions": {}
                };
            }
            var iceOptions = match(mblock, regexps.iceoptions, "m", sblock);
            if (iceOptions) {
                var canTrickle = match(iceOptions[1], regexps.trickle);
                if (canTrickle) {
                    if (!mediaDescription.ice) {
                        mediaDescription.ice = {
                            "iceOptions": {}
                        };
                    }
                    mediaDescription.ice.iceOptions = {
                        "trickle": true
                    };
                }
            }
            var candidateLines = match(mblock, regexps.candidate, "mig");
            if (candidateLines) {
                if (!mediaDescription.ice)
                    mediaDescription.ice = {
                        "iceOptions": {}
                    };
                mediaDescription.ice.candidates = [];
                candidateLines.forEach(function (line) {
                    var candidateLine = match(line, regexps.candidate, "mi");
                    var candidate = {
                        "foundation": candidateLine[1],
                        "componentId": parseInt(candidateLine[2]),
                        "transport": candidateLine[3].toUpperCase(),
                        "priority": parseInt(candidateLine[4]),
                        "address": candidateLine[5],
                        "port": parseInt(candidateLine[6]),
                        "type": candidateLine[7]
                    };
                    if (candidateLine[9])
                        candidate.relatedAddress = candidateLine[9];
                    if (!isNaN(candidateLine[10]))
                        candidate.relatedPort = parseInt(candidateLine[10]);
                    if (candidateLine[12])
                        candidate.tcpType = candidateLine[12];
                    else if (candidate.transport == "TCP") {
                        if (candidate.port == 0 || candidate.port == 9) {
                            candidate.tcpType = "active";
                            candidate.port = 9;
                        } else {
                            return;
                        }
                    }
                    mediaDescription.ice.candidates.push(candidate);
                });
            }

            var fingerprint = match(mblock, regexps.fingerprint, "mi", sblock);
            if (fingerprint) {
                mediaDescription.dtls = {
                    "fingerprintHashFunction": fingerprint[1].toLowerCase(),
                    "fingerprint": fingerprint[2].toUpperCase()
                };
            }
            var setup = match(mblock, regexps.setup, "m", sblock);
            if (setup) {
                if (!mediaDescription.dtls)
                    mediaDescription.dtls = {};
                mediaDescription.dtls.setup = setup[1];
            }

            if (mediaDescription.protocol == "DTLS/SCTP") {
                mediaDescription.sctp = {
                    "port": fmt[0]
                };
                var sctpmapLine = fillTemplate(regexps.sctpmap, mediaDescription.sctp);
                var sctpmap = match(mblock, sctpmapLine, "m");
                if (sctpmap) {
                    mediaDescription.sctp.app = sctpmap[1];
                    if (sctpmap[2])
                        mediaDescription.sctp.streams = parseInt(sctpmap[2]);
                }
            }

            sdpObj.mediaDescriptions.push(mediaDescription);
        }

        return sdpObj;
    };

    SDP.generate = function (sdpObj) {
        sdpObj = JSON.parse(JSON.stringify(sdpObj));
        addDefaults(sdpObj, {
            "version": 0,
            "originator": {},
            "sessionName": "-",
            "startTime": 0,
            "stopTime": 0,
            "mediaDescriptions": []
        });
        addDefaults(sdpObj.originator, {
            "username": "-",
            "sessionId": "" + Math.floor((Math.random() + +new Date()) * 1e6),
            "sessionVersion": 1,
            "netType": "IN",
            "addressType": "IP4",
            "address": "127.0.0.1"
        });
        var sdpText = fillTemplate(templates.sdp, sdpObj);
        sdpText = fillTemplate(sdpText, sdpObj.originator);

        var msidsemanticLine = "";
        var mediaStreamIds = [];
        sdpObj.mediaDescriptions.forEach(function (mdesc) {
            if (mdesc.mediaStreamId && mdesc.mediaStreamTrackId
                && mediaStreamIds.indexOf(mdesc.mediaStreamId) == -1)
                mediaStreamIds.push(mdesc.mediaStreamId);
        });
        if (mediaStreamIds.length) {
            msidsemanticLine = fillTemplate(templates.msidsemantic,
                { "mediaStreamIds": mediaStreamIds.join(" ") });
        }
        sdpText = fillTemplate(sdpText, { "msidsemanticLine": msidsemanticLine });

        sdpObj.mediaDescriptions.forEach(function (mediaDescription) {
            addDefaults(mediaDescription, {
                "port": 9,
                "protocol": "UDP/TLS/RTP/SAVPF",
                "netType": "IN",
                "addressType": "IP4",
                "address": "0.0.0.0",
                "mode": "sendrecv",
                "payloads": [],
                "rtcp": {}
            });
            var mblock = fillTemplate(templates.mblock, mediaDescription);

            var payloadInfo = {"rtpMapLines": "", "fmtpLines": "", "nackLines": "",
                "nackpliLines": "", "ccmfirLines": "", "ericScreamLines": ""};
            mediaDescription.payloads.forEach(function (payload) {
                if (payloadInfo.fmt)
                    payloadInfo.fmt += " " + payload.type;
                else
                    payloadInfo.fmt = payload.type;
                if (!payload.channels || payload.channels == 1)
                    payload.channels = null;
                payloadInfo.rtpMapLines += fillTemplate(templates.rtpMap, payload);
                if (payload.parameters) {
                    var fmtpInfo = { "type": payload.type, "parameters": "" };
                    for (var p in payload.parameters) {
                        var param = p.replace(/([A-Z])([a-z])/g, function (_, a, b) {
                            return "-" + a.toLowerCase() + b;
                        });
                        if (fmtpInfo.parameters)
                            fmtpInfo.parameters += ";";
                        fmtpInfo.parameters += param + "=" + payload.parameters[p];
                    }
                    payloadInfo.fmtpLines += fillTemplate(templates.fmtp, fmtpInfo);
                }
                if (payload.nack)
                    payloadInfo.nackLines += fillTemplate(templates.nack, payload);
                if (payload.nackpli)
                    payloadInfo.nackpliLines += fillTemplate(templates.nackpli, payload);
                if (payload.ccmfir)
                    payloadInfo.ccmfirLines += fillTemplate(templates.ccmfir, payload);
                if (payload.ericscream)
                    payloadInfo.ericScreamLines += fillTemplate(templates.ericscream, payload);
            });
            mblock = fillTemplate(mblock, payloadInfo);

            var rtcpInfo = {"rtcpLine": "", "rtcpMuxLine": ""};
            if (mediaDescription.rtcp.port) {
                addDefaults(mediaDescription.rtcp, {
                    "netType": "IN",
                    "addressType": "IP4",
                    "address": ""
                });
                if (!mediaDescription.rtcp.address)
                    mediaDescription.rtcp.netType = mediaDescription.rtcp.addressType = "";
                rtcpInfo.rtcpLine = fillTemplate(templates.rtcp, mediaDescription.rtcp);
            }
            if (mediaDescription.rtcp.mux)
                rtcpInfo.rtcpMuxLine = templates.rtcpMux;
            mblock = fillTemplate(mblock, rtcpInfo);

            var srcAttributeLines = { "cnameLines": "", "msidLines": "" };
            var srcAttributes = {
                "cname": mediaDescription.cname,
                "mediaStreamId": mediaDescription.mediaStreamId,
                "mediaStreamTrackId": mediaDescription.mediaStreamTrackId
            };
            if (mediaDescription.cname && mediaDescription.ssrcs) {
                mediaDescription.ssrcs.forEach(function (ssrc) {
                    srcAttributes.ssrc = ssrc;
                    srcAttributeLines.cnameLines += fillTemplate(templates.cname, srcAttributes);
                    if (mediaDescription.mediaStreamId && mediaDescription.mediaStreamTrackId)
                        srcAttributeLines.msidLines += fillTemplate(templates.msid, srcAttributes);
                });
            } else if (mediaDescription.mediaStreamId && mediaDescription.mediaStreamTrackId) {
                srcAttributes.ssrc = null;
                srcAttributeLines.msidLines += fillTemplate(templates.msid, srcAttributes);
            }
            mblock = fillTemplate(mblock, srcAttributeLines);

            var iceInfo = {"iceCredentialLines": "", "iceOptionLine": "", "candidateLines": ""};
            if (mediaDescription.ice) {
                iceInfo.iceCredentialLines = fillTemplate(templates.iceCredentials,
                    mediaDescription.ice);
                if (mediaDescription.ice.iceOptions && mediaDescription.ice.iceOptions.trickle)
                    iceInfo.iceOptionLine = templates.iceOptionsTrickle;
                if (mediaDescription.ice.candidates) {
                    mediaDescription.ice.candidates.forEach(function (candidate) {
                        addDefaults(candidate, {
                            "relatedAddress": null,
                            "relatedPort": null,
                            "tcpType": null
                        });
                        iceInfo.candidateLines += fillTemplate(templates.candidate, candidate);
                    });
                }
            }
            mblock = fillTemplate(mblock, iceInfo);

            var dtlsInfo = { "dtlsFingerprintLine": "", "dtlsSetupLine": "" };
            if (mediaDescription.dtls) {
                if (mediaDescription.dtls.fingerprint) {
                    dtlsInfo.dtlsFingerprintLine = fillTemplate(templates.dtlsFingerprint,
                        mediaDescription.dtls);
                }
                addDefaults(mediaDescription.dtls, {"setup": "actpass"});
                dtlsInfo.dtlsSetupLine = fillTemplate(templates.dtlsSetup, mediaDescription.dtls);
            }
            mblock = fillTemplate(mblock, dtlsInfo);

            var sctpInfo = {"sctpmapLine": "", "fmt": ""};
            if (mediaDescription.sctp) {
                addDefaults(mediaDescription.sctp, {"streams": null});
                sctpInfo.sctpmapLine = fillTemplate(templates.sctpmap, mediaDescription.sctp);
                sctpInfo.fmt = mediaDescription.sctp.port;
            }
            mblock = fillTemplate(mblock, sctpInfo);

            sdpText += mblock;
        });

        return sdpText;
    };
})();

if (typeof(module) != "undefined" && typeof(exports) != "undefined")
    module.exports = SDP;
/*
 * Copyright (C) 2014-2015 Ericsson AB. All rights reserved.
 * Copyright (C) 2015 Collabora Ltd.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer
 *    in the documentation and/or other materials provided with the
 *    distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

"use strict";

(function (global) {

    var signalingStateMap = {
        "stable": {
            "setLocal:offer": "have-local-offer",
            "setRemote:offer": "have-remote-offer"
        },
        "have-local-offer": {
            "setLocal:offer": "have-local-offer",
            "setRemote:answer": "stable"
        },
        "have-remote-offer": {
            "setLocal:answer": "stable",
            "setRemote:offer": "have-remote-offer"
        }
    };

    var defaultPayloads = {
        "audio" : [
            { "encodingName": "OPUS", "type": 111, "clockRate": 48000, "channels": 2 },
            { "encodingName": "PCMA", "type": 8, "clockRate": 8000, "channels": 1 },
            { "encodingName": "PCMU", "type": 0, "clockRate": 8000, "channels": 1 },
        ],
        "video": [
            { "encodingName": "H264", "type": 103, "clockRate": 90000,
                "ccmfir": true, "nackpli": true, "ericscream": true, /* "nack": true, */
                "parameters": { "levelAsymmetryAllowed": 1, "packetizationMode": 1 } },
        /* It turns our Chrome still does not handle RTX for h264 correctly, so making
        it not be negotiated
            { "encodingName": "RTX", "type": 123, "clockRate": 90000,
                "parameters": { "apt": 103, "rtxTime": 200 } },  */
            { "encodingName": "VP8", "type": 100, "clockRate": 90000,
                "ccmfir": true, "nackpli": true, "nack": true, "ericscream": true },
            { "encodingName": "RTX", "type": 120, "clockRate": 90000,
                "parameters": { "apt": 100, "rtxTime": 200 } }
        ]
    };

    var messageChannel = new function () {
        var _this = this;
        var iframe;
        var sendQueue = [];

        function createIframe() {
            if (window.location.protocol == "data:")
                return;
            iframe = document.createElement("iframe");
            iframe.style.height = iframe.style.width = "0px";
            iframe.style.visibility = "hidden";
            iframe.onload = function () {
                iframe.onload = null;
                processSendQueue();
            };
            window.addEventListener("message", function (event) {
                if (event.source === iframe.contentWindow && _this.onmessage instanceof Function)
                    _this.onmessage(event);
            });
            iframe.src = "data:text/html;base64," + btoa("<script>\n" +
                "var ws;\n" +
                "var sendQueue = [];\n" +

                "function ensureWebSocket() {\n" +
                "    if (ws && ws.readyState <= ws.OPEN)\n" +
                "        return;\n" +

                "    ws = new WebSocket(\"ws://localhost:10717/bridge\",\n" +
                "        \"" + originToken + "\");\n" +
                "    ws.onopen = processSendQueue;\n" +
                "    ws.onmessage = function (event) {\n" +
                "        window.parent.postMessage(event.data, \"*\");\n" +
                "    };\n" +
                "    ws.onclose = ws.onerror = function () {\n" +
                "        ws = null;\n" +
                "    };\n" +
                "}\n" +

                "function processSendQueue() {\n" +
                "    if (!ws || ws.readyState != ws.OPEN)\n" +
                "        return;\n" +
                "    for (var i = 0; i < sendQueue.length; i++)\n" +
                "        ws.send(sendQueue[i]);\n" +
                "    sendQueue = [];\n" +
                "}\n" +

                "window.onmessage = function (event) {\n" +
                "    sendQueue.push(event.data);\n" +
                "    ensureWebSocket();\n" +
                "    processSendQueue();\n" +
                "};\n" +
                "</script>");
            document.documentElement.appendChild(iframe);
        }

        if (document.readyState == "loading")
            document.addEventListener("DOMContentLoaded", createIframe);
        else
            createIframe();

        function processSendQueue() {
            if (!iframe || iframe.onload)
                return;
            for (var i = 0; i < sendQueue.length; i++)
                iframe.contentWindow.postMessage(sendQueue[i], "*");
            sendQueue = [];
        }

        this.postMessage = function (message) {
            sendQueue.push(message);
            processSendQueue();
        };

        this.onmessage = null;
    };

    var sourceInfoMap = {};
    var renderControllerMap = {};

    var bridge = new JsonRpc(messageChannel);
    bridge.importFunctions("createPeerHandler", "requestSources", "renderSources", "createKeys");

    var dtlsInfo;
    var deferredCreatePeerHandlers = [];
    var called = false;
    var dtlsGen;
   /* var dtlsGen = new Promise( function (resolve,reject) {
        var client = {};
        client.dtlsInfoGenerationDone = function (generatedDtlsInfo) {
	        called = true;
            dtlsInfo = generatedDtlsInfo;
            if (!dtlsInfo)
                console.log("createKeys returned without any dtlsInfo - anything involving use of PeerConnection won't work");
            else {
                var func;
                while ((func = deferredCreatePeerHandlers.shift()))
                    func();
            }
            resolve(dtlsInfo);
            bridge.removeObjectRef(client);
        }


        bridge.createKeys(bridge.createObjectRef(client, "dtlsInfoGenerationDone"));

    });*/

    var dtlsGen = function () {
        var client = {};
        client.dtlsInfoGenerationDone = function (generatedDtlsInfo) {
	        called = true;
            dtlsInfo = generatedDtlsInfo;
            if (!dtlsInfo)
                console.log("createKeys returned without any dtlsInfo - anything involving use of PeerConnection won't work");
            else {
                var func;
                while ((func = deferredCreatePeerHandlers.shift()))
                    func();
            }
            bridge.removeObjectRef(client);
        }


        bridge.createKeys(bridge.createObjectRef(client, "dtlsInfoGenerationDone"));

    };

    function getUserMedia(options) {
        checkArguments("getUserMedia", "dictionary", 1, arguments);

        return internalGetUserMedia(options);
    }

    function legacyGetUserMedia(options, successCallback, errorCallback) {
        checkArguments("getUserMedia", "dictionary, function, function", 3, arguments);

        internalGetUserMedia(options).then(successCallback).catch(errorCallback);
    }

    function internalGetUserMedia(options) {
        checkDictionary("MediaStreamConstraints", options, {
            "audio": "object | boolean",
            "video": "object | boolean"
        });

        if (!options.audio && !options.video) {
            throw new MediaStreamError({
                "name": "NotSupportedError",
                "message": "Options has no media"
            });
        }

        return new Promise(function (resolve, reject) {
            var client = {};
            client.gotSources = function (sourceInfos) {
                var trackList = sourceInfos.map(function (sourceInfo) {
                    return new MediaStreamTrack(sourceInfo);
                });
                bridge.removeObjectRef(client);
                resolve(new MediaStream(trackList));
            };
            client.noSources = function (reason) {
                var name = "AbortError";
                var message = "Aborted";
                if (reason == "rejected") {
                    name = "PermissionDeniedError";
                    message = "The user did not grant permission for the operation.";
                }
                else if (reason == "notavailable") {
                    name = "SourceUnavailableError";
                    message = "The sources available did not match the requirements.";
                }
                reject(new MediaStreamError({
                    "name": name,
                    "message": message
                }));
            }
            bridge.requestSources(options, bridge.createObjectRef(client, "gotSources", "noSources"));
        });
    }

    getUserMedia.toString = function () {
        return "function getUserMedia() { [not native code] }";
    };

    //
    // MediaStream
    //
    MediaStream.prototype = Object.create(EventTarget.prototype);
    MediaStream.prototype.constructor = MediaStream;

    function MediaStream() { // (MediaStream or sequence<MediaStreamTrack>)
        checkArguments("MediaStream", "webkitMediaStream | Array", 1, arguments);

        EventTarget.call(this, {
            "onactive": null,
            "oninactive": null,
            "onaddtrack": null,
            "onremovetrack": null
        });

        var a = { // attributes
            "id": mediaStreamPrivateInit.id || randomString(36),
            "active": false
        };
        domObject.addReadOnlyAttributes(this, a);

        var trackSet = {};

        var constructorTracks = arguments[0] instanceof MediaStream ? arguments[0].getTracks() : arguments[0];
        constructorTracks.forEach(function (track) {
            if (!(track instanceof MediaStreamTrack))
                throw createError("TypeError", "MediaStream: list item is not a MediaStreamTrack");

            if (!a.active && track.readyState != "ended")
                a.active = true;
            trackSet[track.id] = track;
        });
        arguments[0] = constructorTracks = null;


        this.onended = null;
        this.toString = MediaStream.toString;

        this.getAudioTracks = function () {
            return toTrackList("audio");
        };

        this.getVideoTracks = function () {
            return toTrackList("video");
        };

        this.getTracks = function () {
            return toTrackList();
        };

        this.getTrackById = function (id) {
            checkArguments("getTrackById", "string", 1, arguments);

            return trackSet[id] || null;
        }

        this.clone = function () {
            var trackClones = toTrackList().map(function (track) {
                return track.clone();
            });
            return new MediaStream(trackClones);
        }

        function toTrackList(kind) {
            var list = [];
            Object.keys(trackSet).forEach(function (key) {
                if (!kind || trackSet[key].kind == kind)
                    list.push(trackSet[key]);
            });
            return list;
        }
    }

    MediaStream.toString = function () {
        return "[object MediaStream]";
    };

    var mediaStreamPrivateInit = {};
    function createMediaStream(trackListOrStream, id) {
        mediaStreamPrivateInit = { "id": id };
        var stream = new MediaStream(trackListOrStream);
        mediaStreamPrivateInit = {};
        return stream;
    }

    //
    // MediaStreamTrack
    //
    MediaStreamTrack.prototype = Object.create(EventTarget.prototype);
    MediaStreamTrack.prototype.constructor = MediaStreamTrack;

    function MediaStreamTrack(sourceInfo, id) {

        EventTarget.call(this, {
            "onmute": null,
            "onunmute": null,
            "onended": null,
            "onoverconstrained": null
        });

        var a = { // attributes
            "kind": sourceInfo.mediaType,
            "id": id || randomString(36),
            "label": sourceInfo.label,
            "muted": false,
            "readyState": "live"
        };
        domObject.addReadOnlyAttributes(this, a);

        sourceInfoMap[a.id] = sourceInfo;

        this.toString = MediaStreamTrack.toString;

        this.clone = function () {
            return new MediaStreamTrack(sourceInfo);
        };

        this.stop = function () {

        };
    }

    MediaStreamTrack.toString = function () {
        return "[object MediaStreamTrack]";
    };

    function MediaStreamError(initDict) {
        if (!initDict)
            initDict = {};

        var a = { // attributes
            "name": initDict.name || "MediaStreamError",
            "message": initDict.message || null,
            "constraintName": initDict.constraintName || null
        };
        domObject.addReadOnlyAttributes(this, a);

        this.toString = function () {
            return a.name + ": " + (a.message ? a.message : "");
        };
    }

    //
    // RTCPeerConnection
    //
    RTCPeerConnection.prototype = Object.create(EventTarget.prototype);
    RTCPeerConnection.prototype.constructor = RTCPeerConnection;
    RTCPeerConnection.prototype.createDataChannel = function () {
        console.warn("createDataChannel only exposed on the prototype for feature probing");
    };

    function RTCPeerConnection(configuration) {
        var _this = this;

         EventTarget.call(this, {
            "onnegotiationneeded": null,
            "onicecandidate": null,
            "onsignalingstatechange": null,
            "onaddstream": null,
            "onremovestream": null,
            "oniceconnectionstatechange": null,
            "ondatachannel": null
        });

        var a = { // attributes
            "localDescription": getLocalDescription,
            "remoteDescription": getRemoteDescription,
            "signalingState": "stable",
            "iceGatheringState": "new",
            "iceConnectionState": "new",
            "canTrickleIceCandidates": null
        };
        domObject.addReadOnlyAttributes(this, a);

        checkArguments("RTCPeerConnection", "dictionary", 1, arguments);
        checkConfigurationDictionary(configuration);

        if (!configuration.iceTransports)
            configuration.iceTransports = "all"

        var localStreams = [];
        var remoteStreams = [];

        var peerHandler;
        var peerHandlerClient = createPeerHandlerClient();
        var clientRef = bridge.createObjectRef(peerHandlerClient,
            "gotIceCandidate", "candidateGatheringDone", "gotRemoteSource",
            "dataChannelsEnabled", "dataChannelRequested");
        var deferredPeerHandlerCalls = [];

        function createPeerHandler() {
            bridge.createPeerHandler(configuration, {"key": dtlsInfo.privatekey, "certificate": dtlsInfo.certificate}, clientRef, function (ph) {
                peerHandler = ph;

                var func;
                while ((func = deferredPeerHandlerCalls.shift()))
                    func();
            });
        }

        if (dtlsInfo)
            createPeerHandler()
        else
            deferredCreatePeerHandlers.push(createPeerHandler);


        function whenPeerHandler(func) {
            if (peerHandler)
                func();
            else
                deferredPeerHandlerCalls.push(func);
        }

        var canCreateDataChannels = false;
        var deferredCreateDataChannelCalls = [];

        function whenPeerHandlerCanCreateDataChannels(func) {
            if (peerHandler && canCreateDataChannels)
                func(peerHandler);
            else
                deferredCreateDataChannelCalls.push(func);
        }

        var cname = randomString(16);
        var negotiationNeededTimerHandle;
        var hasDataChannels = false;
        var localSessionInfo = null;
        var remoteSessionInfo = null;
        var remoteSourceStatus = [];
        var lastSetLocalDescriptionType;
        var lastSetRemoteDescriptionType;
        var queuedOperations = [];
        var stateChangingOperationsQueued = false;

        function enqueueOperation(operation, isStateChanger) {
            queuedOperations.push(operation);
            stateChangingOperationsQueued = !!isStateChanger;
            if (queuedOperations.length == 1)
                setTimeout(queuedOperations[0]);
        }

        function completeQueuedOperation(callback) {
            queuedOperations.shift();
            if (queuedOperations.length)
                setTimeout(queuedOperations[0],2000);

            try {
                callback();
            } catch (e) {
                setTimeout(function () {
                    throw e;
                });
            }

            if (!queuedOperations.length && stateChangingOperationsQueued) {
                maybeDispatchNegotiationNeeded();
                stateChangingOperationsQueued = false;
            }
        }

        function updateMediaDescriptionsWithTracks(mediaDescriptions, trackInfos) {
            mediaDescriptions.forEach(function (mdesc) {
                var index = indexOfByProperty(trackInfos, "mediaStreamTrackId",
                    mdesc.mediaStreamTrackId);
                if (index != -1)
                    trackInfos.splice(index, 1);
                else {
                    mdesc.mediaStreamId = null;
                    mdesc.mediaStreamTrackId = null;
                }
            });

            mediaDescriptions.forEach(function (mdesc) {
                if (mdesc.mediaStreamTrackId)
                    return;

                var index = indexOfByProperty(trackInfos, "kind", mdesc.type);
                if (index != -1) {
                    mdesc.mediaStreamId = trackInfos[index].mediaStreamId;
                    mdesc.mediaStreamTrackId = trackInfos[index].mediaStreamTrackId;
                    mdesc.mode = "sendrecv";
                    trackInfos.splice(index, 1);
                } else
                    mdesc.mode = "recvonly";
            });
        }

        this.createOffer = function () {
            // backwards compatibility with callback based method
            var callbackArgsError = getArgumentsError("function, function, dictionary", 2, arguments);
            if (!callbackArgsError) {
                internalCreateOffer(arguments[2]).then(arguments[0]).catch(arguments[1]);
                return;
            }

            var promiseArgsError = getArgumentsError("dictionary", 0, arguments);
            if (!promiseArgsError)
                return internalCreateOffer(arguments[0]);

            throwNoMatchingSignature("createOffer", promiseArgsError, callbackArgsError);
        };

        function internalCreateOffer(options) {
            if (options) {
                checkDictionary("RTCOfferOptions", options, {
                    "offerToReceiveVideo": "number | boolean",
                    "offerToReceiveAudio": "number | boolean"
                });
            }
            checkClosedState("createOffer");

            return new Promise(function (resolve, reject) {
                enqueueOperation(function () {
                    queuedCreateOffer(resolve, reject, options);
                });
            });
        }

        function queuedCreateOffer(resolve, reject, options) {
	        dtlsGen();
          setTimeout(function () {
            options = options || {};
            options.offerToReceiveAudio = +options.offerToReceiveAudio || 0;
            options.offerToReceiveVideo = +options.offerToReceiveVideo || 0;

            var localSessionInfoSnapshot = localSessionInfo ?
                JSON.parse(JSON.stringify(localSessionInfo)) : { "mediaDescriptions": [] };

            var localTrackInfos = getTrackInfos(localStreams);
            updateMediaDescriptionsWithTracks(localSessionInfoSnapshot.mediaDescriptions,
                localTrackInfos);

            localTrackInfos.forEach(function (trackInfo) {
                localSessionInfoSnapshot.mediaDescriptions.push({
                    "mediaStreamId": trackInfo.mediaStreamId,
                    "mediaStreamTrackId": trackInfo.mediaStreamTrackId,
                    "type": trackInfo.kind,
                    "payloads": JSON.parse(JSON.stringify(defaultPayloads[trackInfo.kind])),
                    "rtcp": { "mux": true },
                    "ssrcs": [ randomNumber(32) ],
                    "cname": cname,
                    "ice": { "ufrag": randomString(4), "password": randomString(22),
                        "iceOptions": { "trickle": true } },
                    "dtls": {
                        "setup": "actpass",
                        "fingerprintHashFunction": dtlsInfo.fingerprintHashFunction,
                        "fingerprint": dtlsInfo.fingerprint.toUpperCase()
                    }
                });
            });

            [ "Audio", "Video" ].forEach(function (mediaType) {
                for (var i = 0; i < options["offerToReceive" + mediaType]; i++) {
                    var kind = mediaType.toLowerCase();
                    localSessionInfoSnapshot.mediaDescriptions.push({
                        "type": kind,
                        "payloads": JSON.parse(JSON.stringify(defaultPayloads[kind])),
                        "rtcp": { "mux": true },
                        "dtls": {
                            "setup": "actpass",
                            "fingerprintHashFunction": dtlsInfo.fingerprintHashFunction,
                            "fingerprint": dtlsInfo.fingerprint.toUpperCase()
                        },
                        "mode": "recvonly"
                    });
                }
            });

            if (hasDataChannels && indexOfByProperty(localSessionInfoSnapshot.mediaDescriptions,
                "type", "application") == -1) {
                localSessionInfoSnapshot.mediaDescriptions.push({
                    "type": "application",
                    "protocol": "DTLS/SCTP",
                    "fmt": 5000,
                    "ice": { "ufrag": randomString(4), "password": randomString(22),
                        "iceOptions": { "trickle": true } },
                    "dtls": {
                        "setup": "actpass",
                        "fingerprintHashFunction": dtlsInfo.fingerprintHashFunction,
                        "fingerprint": dtlsInfo.fingerprint.toUpperCase()
                    },
                    "sctp": {
                        "port": 5000,
                        "app": "webrtc-datachannel",
                        "streams": 1024
                    }
                });
            }
          },3000);


            completeQueuedOperation(function () {
                resolve(new RTCSessionDescription({
                    "type": "offer",
                    "sdp": SDP.generate(localSessionInfoSnapshot)
                }));
            });
        }

        this.createAnswer = function () {
            // backwards compatibility with callback based method
            var callbackArgsError = getArgumentsError("function, function, dictionary", 2, arguments);
            if (!callbackArgsError) {
                internalCreateAnswer(arguments[2]).then(arguments[0]).catch(arguments[1]);
                return;
            }

            var promiseArgsError = getArgumentsError("dictionary", 0, arguments);
            if (!promiseArgsError)
                return internalCreateAnswer(arguments[0]);

            throwNoMatchingSignature("createAnswer", promiseArgsError, callbackArgsError);
        };

        function internalCreateAnswer(options) {
            if (options) {
                checkDictionary("RTCOfferOptions", options, {
                    "offerToReceiveVideo": "number | boolean",
                    "offerToReceiveAudio": "number | boolean"
                });
            }
            checkClosedState("createAnswer");

            return new Promise(function (resolve, reject) {
                enqueueOperation(function () {
                    queuedCreateAnswer(resolve, reject, options);
                });
            });
        }

        function queuedCreateAnswer(resolve, reject, options) {

            if (!remoteSessionInfo) {
                completeQueuedOperation(function () {
                    reject(createError("InvalidStateError",
                        "createAnswer: no remote description set"));
                });
                return;
            }

            var localSessionInfoSnapshot = localSessionInfo ?
                JSON.parse(JSON.stringify(localSessionInfo)) : { "mediaDescriptions": [] };

            var iceOptions = {};
            for (var i = 0; i < remoteSessionInfo.mediaDescriptions.length; i++) {
                if (remoteSessionInfo.mediaDescriptions[i].ice.iceOptions.trickle)
                    iceOptions.trickle = true;
            }

            for (var i = 0; i < remoteSessionInfo.mediaDescriptions.length; i++) {
                var lmdesc = localSessionInfoSnapshot.mediaDescriptions[i];
                var rmdesc = remoteSessionInfo.mediaDescriptions[i];
                if (!lmdesc) {
                    lmdesc = {
                        "type": rmdesc.type,
                        "ice": { "ufrag": randomString(4), "password": randomString(22),
                            "iceOptions": iceOptions },
                        "dtls": {
                            "setup": rmdesc.dtls.setup == "active" ? "passive" : "active",
                            "fingerprintHashFunction": dtlsInfo.fingerprintHashFunction,
                            "fingerprint": dtlsInfo.fingerprint.toUpperCase()
                        }
                    };
                    localSessionInfoSnapshot.mediaDescriptions.push(lmdesc);
                }

                if (lmdesc.type == "application") {
                    lmdesc.protocol = "DTLS/SCTP";
                    lmdesc.sctp = {
                        "port": 5000,
                        "app": "webrtc-datachannel"
                    };
                    if (rmdesc.sctp) {
                        lmdesc.sctp.streams = rmdesc.sctp.streams;
                    }
                } else {
                    lmdesc.payloads = rmdesc.payloads;

                    if (!lmdesc.rtcp)
                        lmdesc.rtcp = {};

                    lmdesc.rtcp.mux = !!(rmdesc.rtcp && rmdesc.rtcp.mux);

                    do {
                        lmdesc.ssrcs = [ randomNumber(32) ];
                    } while (rmdesc.ssrcs && rmdesc.ssrcs.indexOf(lmdesc.ssrcs[0]) != -1);

                    lmdesc.cname = cname;
                }

                if (lmdesc.dtls.setup == "actpass")
                    lmdesc.dtls.setup = "passive";
            }

            var localTrackInfos = getTrackInfos(localStreams);
            updateMediaDescriptionsWithTracks(localSessionInfoSnapshot.mediaDescriptions,
                localTrackInfos);

            completeQueuedOperation(function () {
                resolve(new RTCSessionDescription({
                    "type": "answer",
                    "sdp": SDP.generate(localSessionInfoSnapshot)
                }));
            });
        }

        this.setLocalDescription = function () {
            // backwards compatibility with callback based method
            var callbackArgsError = getArgumentsError("RTCSessionDescription, function, function", 3, arguments);
            if (!callbackArgsError) {
                internalSetLocalDescription(arguments[0]).then(arguments[1]).catch(arguments[2]);
                return;
            }

            var promiseArgsError = getArgumentsError("RTCSessionDescription", 1, arguments);
            if (!promiseArgsError)
                return internalSetLocalDescription(arguments[0]);

            throwNoMatchingSignature("setLocalDescription", promiseArgsError, callbackArgsError);
        };

        function internalSetLocalDescription(description) {
            checkClosedState("setLocalDescription");

            return new Promise(function (resolve, reject) {
                enqueueOperation(function () {
                    queuedSetLocalDescription(description, resolve, reject);
                }, true);
            });
        }

        function queuedSetLocalDescription(description, resolve, reject) {
            var targetState = signalingStateMap[a.signalingState]["setLocal:" + description.type];
            if (!targetState) {
                completeQueuedOperation(function () {
                    reject(createError("InvalidSessionDescriptionError",
                        "setLocalDescription: description type \"" +
                        entityReplace(description.type) + "\" invalid for the current state \"" +
                        a.signalingState + "\""));
                });
                return;
            }

            var previousNumberOfMediaDescriptions = localSessionInfo ?
                localSessionInfo.mediaDescriptions.length : 0;

            localSessionInfo = SDP.parse(description.sdp);
            lastSetLocalDescriptionType = description.type;

            var hasNewMediaDescriptions = localSessionInfo.mediaDescriptions.length >
                previousNumberOfMediaDescriptions;

            var isInitiator = description.type == "offer";
            whenPeerHandler(function () {
                if (hasNewMediaDescriptions)
                    peerHandler.prepareToReceive(localSessionInfo, isInitiator);

                if (remoteSessionInfo)
                    peerHandler.prepareToSend(remoteSessionInfo, isInitiator);

                completeQueuedOperation(function () {
                    a.signalingState = targetState;
                    resolve();
                });
            });
        }

        this.setRemoteDescription = function () {
            // backwards compatibility with callback based method
            var callbackArgsError = getArgumentsError("RTCSessionDescription, function, function", 3, arguments);
            if (!callbackArgsError) {
                internalSetRemoteDescription(arguments[0]).then(arguments[1]).catch(arguments[2]);
                return;
            }

            var promiseArgsError = getArgumentsError("RTCSessionDescription", 1, arguments);
            if (!promiseArgsError)
                return internalSetRemoteDescription(arguments[0]);

            throwNoMatchingSignature("setRemoteDescription", promiseArgsError, callbackArgsError);
        };

        function internalSetRemoteDescription(description) {
            checkClosedState("setRemoteDescription");

            return new Promise(function (resolve, reject) {
                enqueueOperation(function () {
                    queuedSetRemoteDescription(description, resolve, reject);
                }, true);
            });
        }

        function queuedSetRemoteDescription(description, resolve, reject) {
            var targetState = signalingStateMap[a.signalingState]["setRemote:" + description.type];
            if (!targetState) {
                completeQueuedOperation(function () {
                    reject(createError("InvalidSessionDescriptionError",
                        "setRemoteDescription: description type \"" +
                        entityReplace(description.type) + "\" invalid for the current state \"" +
                        a.signalingState + "\""));
                });
                return;
            }

            remoteSessionInfo = SDP.parse(description.sdp);
            lastSetRemoteDescriptionType = description.type;

            var canTrickle = false;
            remoteSessionInfo.mediaDescriptions.forEach(function (mdesc, i) {
                if (!remoteSourceStatus[i])
                    remoteSourceStatus[i] = {};

                remoteSourceStatus[i].sourceExpected = mdesc.mode != "recvonly";

                if (!mdesc.ice) {
                    console.warn("setRemoteDescription: m-line " + i +
                        " is missing ICE credentials");
                    mdesc.ice = {
                        "iceOptions": {}
                    };
                }
                if (mdesc.ice.iceOptions.trickle)
                    canTrickle = true;
            });

            var allTracks = getAllTracks(localStreams);
            remoteSessionInfo.mediaDescriptions.forEach(function (mdesc) {
                if (mdesc.type != "audio" && mdesc.type != "video")
                    return;

                var filteredPayloads = mdesc.payloads.filter(function (payload) {
                    var index = indexOfByProperty(defaultPayloads[mdesc.type],
                        "encodingName", payload.encodingName.toUpperCase());
                    var dp = defaultPayloads[mdesc.type][index];
                    return dp && (!dp.parameters || !payload.parameters
                        || payload.parameters.packetizationMode == dp.parameters.packetizationMode);

                });
                mdesc.payloads = filteredPayloads.filter(function (payload) {
                    return !payload.parameters || !payload.parameters.apt ||
                    indexOfByProperty(filteredPayloads, "type", payload.parameters.apt) != -1;
                });

                var trackIndex = indexOfByProperty(allTracks, "kind", mdesc.type);
                if (trackIndex != -1) {
                    var track = allTracks.splice(trackIndex, 1)[0];
                    mdesc.source = sourceInfoMap[track.id].source;
                }
            });

            var isInitiator = description.type == "answer";
            whenPeerHandler(function () {
                peerHandler.prepareToSend(remoteSessionInfo, isInitiator);
                completeQueuedOperation(function () {
                    a.signalingState = targetState;
                    a.canTrickleIceCandidates = canTrickle;
                    resolve();
                });
            });
        };

        this.updateIce = function (configuration) {
            checkArguments("updateIce", "dictionary", 1, arguments);
            checkConfigurationDictionary(configuration);
            checkClosedState("updateIce");
        };

        this.addIceCandidate = function () {
            // backwards compatibility with callback based method
            var callbackArgsError = getArgumentsError("RTCIceCandidate, function, function", 3, arguments);
            if (!callbackArgsError) {
                internalAddIceCandidate(arguments[0]).then(arguments[1]).catch(arguments[2]);
                return;
            }

            var promiseArgsError = getArgumentsError("RTCIceCandidate", 1, arguments);
            if (!promiseArgsError)
                return internalAddIceCandidate(arguments[0]);

            throwNoMatchingSignature("addIceCandidate", promiseArgsError, callbackArgsError);
        };

        function internalAddIceCandidate(candidate) {
            checkClosedState("addIceCandidate");

            return new Promise(function (resolve, reject) {
                enqueueOperation(function () {
                    queuedAddIceCandidate(candidate, resolve, reject);
                });
            });
        };

        function queuedAddIceCandidate(candidate, resolve, reject) {
            if (!remoteSessionInfo) {
                completeQueuedOperation(function () {
                    reject(createError("InvalidStateError",
                        "addIceCandidate: no remote description set"));
                });
                return;
            }

            /* handle candidate values in the form <candidate> and a=<candidate>
             * to workaround https://code.google.com/p/webrtc/issues/detail?id=1142
             */
            var candidateAttribute = candidate.candidate;
            if (candidateAttribute.substr(0, 2) != "a=")
                candidateAttribute = "a=" + candidateAttribute;
            var iceInfo = SDP.parse("m=application 0 NONE\r\n" +
                candidateAttribute + "\r\n").mediaDescriptions[0].ice;
            var parsedCandidate = iceInfo && iceInfo.candidates && iceInfo.candidates[0];

            if (!parsedCandidate) {
                completeQueuedOperation(function () {
                    reject(createError("SyntaxError",
                        "addIceCandidate: failed to parse candidate attribute"));
                });
                return;
            }

            var mdesc = remoteSessionInfo.mediaDescriptions[candidate.sdpMLineIndex];
            if (!mdesc) {
                completeQueuedOperation(function () {
                    reject(createError("SyntaxError",
                        "addIceCandidate: no matching media description for sdpMLineIndex: " +
                        entityReplace(candidate.sdpMLineIndex)));
                });
                return;
            }

            if (!mdesc.ice.candidates)
                mdesc.ice.candidates = [];
            mdesc.ice.candidates.push(parsedCandidate);

            whenPeerHandler(function () {
                peerHandler.addRemoteCandidate(parsedCandidate, candidate.sdpMLineIndex,
                    mdesc.ice.ufrag, mdesc.ice.password);
                completeQueuedOperation(resolve);
            });
        };

        this.getConfiguration = function () {
            return JSON.parse(JSON.stringify(configuration));
        };

        this.getLocalStreams = function () {
            return localStreams.slice(0);
        };

        this.getRemoteStreams = function () {
            return remoteStreams.slice(0);
        };

        this.getStreamById = function (streamId) {
            checkArguments("getStreamById", "string", 1, arguments);
            streamId = String(streamId);

            return findInArrayById(localStreams, streamId) || findInArrayById(remoteStreams, streamId);
        };

        this.addStream = function (stream) {
            checkArguments("addStream", "webkitMediaStream", 1, arguments);
            checkClosedState("addStream");

            if (findInArrayById(localStreams, stream.id) || findInArrayById(remoteStreams, stream.id))
                return;

            localStreams.push(stream);
            setTimeout(maybeDispatchNegotiationNeeded);
        };

        this.removeStream = function (stream) {
            checkArguments("removeStream", "webkitMediaStream", 1, arguments);
            checkClosedState("removeStream");

            var index = localStreams.indexOf(stream);
            if (index == -1)
                return;

            localStreams.splice(index, 1);
            setTimeout(maybeDispatchNegotiationNeeded);
        };

        this.createDataChannel = function (label, dataChannelDict) {
            checkArguments("createDataChannel", "string", 1, arguments);
            checkClosedState();

            var initDict = dataChannelDict || {};

            checkDictionary("RTCDataChannelInit", initDict, {
                "ordered": "boolean",
                "maxPacketLifeTime": "number",
                "maxRetransmits": "number",
                "protocol": "string",
                "negotiated": "boolean",
                "id": "number"
            });

            var settings = {
                "label": String(label || ""),
                "ordered": getDictionaryMember(initDict, "ordered", "boolean", true),
                "maxPacketLifeTime": getDictionaryMember(initDict, "maxPacketLifeTime", "number", null),
                "maxRetransmits": getDictionaryMember(initDict, "maxRetransmits", "number", null),
                "protocol": getDictionaryMember(initDict, "protocol", "string", ""),
                "negotiated": getDictionaryMember(initDict, "negotiated", "boolean", false),
                "id": getDictionaryMember(initDict, "id", "number", 65535),
                "readyState": "connecting",
                "bufferedAmount": 0
            };

            if (settings.negotiated && (settings.id < 0 || settings.id > 65534)) {
                throw createError("SyntaxError",
                    "createDataChannel: a negotiated channel requires an id (with value 0 - 65534)");
            }

            if (!settings.negotiated && initDict.hasOwnProperty("id")) {
                console.warn("createDataChannel: id should not be used with a non-negotiated channel");
                settings.id = 65535;
            }

            if (settings.maxPacketLifeTime != null && settings.maxRetransmits != null) {
                throw createError("SyntaxError",
                    "createDataChannel: maxPacketLifeTime and maxRetransmits cannot both be set");
            }

            if (!hasDataChannels) {
                hasDataChannels = true;
                setTimeout(maybeDispatchNegotiationNeeded);
            }

            return new RTCDataChannel(settings, whenPeerHandlerCanCreateDataChannels);
        };

        this.close = function () {
            if (a.signalingState == "closed")
                return;

            a.signalingState = "closed";
        };

        this.toString = RTCPeerConnection.toString;

        function getLocalDescription() {
            if (!localSessionInfo)
                return null;
            return new RTCSessionDescription({
                "type": lastSetLocalDescriptionType,
                "sdp": SDP.generate(localSessionInfo)
            });
        }

        function getRemoteDescription() {
            if (!remoteSessionInfo)
                return null;
            return new RTCSessionDescription({
                "type": lastSetRemoteDescriptionType,
                "sdp": SDP.generate(remoteSessionInfo)
            });
        }

        function checkConfigurationDictionary(configuration) {
            checkDictionary("RTCConfiguration", configuration, {
                "iceServers": "Array",
                "iceTransports": "string"
            });

            if (configuration.iceServers) {
                configuration.iceServers.forEach(function (iceServer) {
                    checkType("RTCConfiguration.iceServers", iceServer, "dictionary");
                    checkDictionary("RTCIceServer", iceServer, {
                        "urls": "Array | string",
                        "url": "string", // legacy support
                        "username": "string",
                        "credential": "string"
                    });
                });
            }
        }

        function checkClosedState(name) {
            if (a.signalingState == "closed")
                throw createError("InvalidStateError", name + ": signalingState is \"closed\"");
        }

        function throwNoMatchingSignature(name, primaryError, legacyError) {
            throw createError("TypeError", name + ": no matching method signature. " +
                "Alternative 1: " + primaryError + ", Alternative 2 (legacy): " + legacyError);
        }

        function maybeDispatchNegotiationNeeded() {
            if (negotiationNeededTimerHandle || queuedOperations.length
                || a.signalingState != "stable")
                return;

            var mediaDescriptions = localSessionInfo ? localSessionInfo.mediaDescriptions : [];

            var dataNegotiationNeeded = hasDataChannels
                && indexOfByProperty(mediaDescriptions, "type", "application") == -1;

            var allTracks = getAllTracks(localStreams);
            var i = 0;
            for (; i < allTracks.length; i++) {
                if (indexOfByProperty(mediaDescriptions, "mediaStreamTrackId",
                    allTracks[i].id) == -1)
                    break;
            }
            var mediaNegotiationNeeded = i < allTracks.length;

            if (!dataNegotiationNeeded && !mediaNegotiationNeeded)
                return;

            negotiationNeededTimerHandle = setTimeout(function () {
                negotiationNeededTimerHandle = 0;
                if (a.signalingState == "stable")
                    _this.dispatchEvent({ "type": "negotiationneeded", "target": _this });
            }, 0);
        }

        function maybeDispatchGatheringDone() {
            if (isAllGatheringDone()) {
                _this.dispatchEvent({ "type": "icecandidate", "candidate": null,
                    "target": _this });
            }
        }

        function dispatchMediaStreamEvent(trackInfos, id) {
            var trackList = trackInfos.map(function (trackInfo) {
                return new MediaStreamTrack(trackInfo.sourceInfo, trackInfo.id);
            });

            var mediaStream = createMediaStream(trackList, id);
            remoteStreams.push(mediaStream);

            _this.dispatchEvent({ "type": "addstream", "stream": mediaStream, "target": _this });
        }

        function getAllTracks(streamList) {
            var allTracks = [];
            streamList.forEach(function (stream) {
                Array.prototype.push.apply(allTracks, stream.getTracks());
            });
            return allTracks;
        }

        function getTrackInfos(streams) {
            var trackInfos = [];
            streams.forEach(function (stream) {
                var trackInfosForStream = stream.getTracks().map(function (track) {
                    return {
                        "kind": track.kind,
                        "mediaStreamTrackId": track.id,
                        "mediaStreamId": stream.id
                    };
                });
                Array.prototype.push.apply(trackInfos, trackInfosForStream);
            });
            return trackInfos;
        }

        function findInArrayById(array, id) {
            for (var i = 0; i < array.length; i++)
                if (array[i].id == id)
                    return array[i];
            return null;
        }

        function indexOfByProperty(array, propertyName, propertyValue) {
            for (var i = 0; i < array.length; i++) {
                if (array[i][propertyName] == propertyValue)
                    return i;
            }
            return -1;
        }

        function dispatchIceCandidate(c, mdescIndex) {
            var candidateAttribute = "candidate:" + c.foundation + " " + c.componentId + " "
                + c.transport + " " + c.priority + " " + c.address + " " + c.port
                + " typ " + c.type;
            if (c.relatedAddress)
                candidateAttribute += " raddr " + c.relatedAddress + " rport " + c.relatedPort;
            if (c.tcpType)
                candidateAttribute += " tcptype " + c.tcpType;

            var candidate = new RTCIceCandidate({
                "candidate": candidateAttribute,
                "sdpMid": "",
                "sdpMLineIndex": mdescIndex
            });
            _this.dispatchEvent({ "type": "icecandidate", "candidate": candidate,
                "target": _this });
        }

        function isAllGatheringDone() {
            for (var i = 0; i < localSessionInfo.mediaDescriptions.length; i++) {
                var mdesc = localSessionInfo.mediaDescriptions[i];
                if (!mdesc.ice.gatheringDone)
                    return false;
            }
            return true;
        }

        function createPeerHandlerClient() {
            var client = {};

            client.gotIceCandidate = function (mdescIndex, candidate, ufrag, password) {
                var mdesc = localSessionInfo.mediaDescriptions[mdescIndex];
                if (!mdesc.ice) {
                    mdesc.ice = {
                        "ufrag": ufrag,
                        "password": password
                    };
                }
                if (!mdesc.ice.candidates)
                    mdesc.ice.candidates = [];
                mdesc.ice.candidates.push(candidate);

                if (candidate.address.indexOf(":") == -1) { // not IPv6
                    if (candidate.componentId == 1) { // RTP
                        if (mdesc.address == "0.0.0.0") {
                            mdesc.address = candidate.address;
                            mdesc.port = candidate.port;
                        }
                    } else { // RTCP
                        if (!mdesc.rtcp.address || !mdesc.rtcp.port) {
                            mdesc.rtcp.address = candidate.address;
                            mdesc.rtcp.port = candidate.port;
                        }
                    }
                }

                dispatchIceCandidate(candidate, mdescIndex);
                maybeDispatchGatheringDone();
            };

            client.candidateGatheringDone = function (mdescIndex) {
                var mdesc = localSessionInfo.mediaDescriptions[mdescIndex];
                mdesc.ice.gatheringDone = true;
                maybeDispatchGatheringDone();
            };

            client.gotRemoteSource = function (mdescIndex, remoteSource) {
                remoteSourceStatus[mdescIndex].source = remoteSource;
                remoteSourceStatus[mdescIndex].isUpdated = true;

                for (var i = 0; i < remoteSourceStatus.length; i++) {
                    var status = remoteSourceStatus[i];
                    if (!status.source && status.sourceExpected)
                        return;
                }

                var legacyRemoteTrackInfos = [];
                var remoteTrackInfos = {};
                remoteSourceStatus.forEach(function (status, i) {
                    if (status.isUpdated) {
                        status.isUpdated = false;
                        var mdesc = remoteSessionInfo.mediaDescriptions[i];
                        var sourceInfo = {
                            "mediaType": mdesc.type,
                            "label": "Remote " + mdesc.type + " source",
                            "source": status.source,
                            "type": "remote"
                        };

                        if (mdesc.mediaStreamId) {
                            if (!remoteTrackInfos[mdesc.mediaStreamId])
                                remoteTrackInfos[mdesc.mediaStreamId] = [];

                            remoteTrackInfos[mdesc.mediaStreamId].push({
                                "sourceInfo": sourceInfo,
                                "id": mdesc.mediaStreamTrackId
                            });
                        } else {
                            legacyRemoteTrackInfos.push({
                                "sourceInfo": sourceInfo,
                            });
                        }
                    }
                });

                Object.keys(remoteTrackInfos).forEach(function (mediaStreamId) {
                    dispatchMediaStreamEvent(remoteTrackInfos[mediaStreamId], mediaStreamId);
                });

                if (legacyRemoteTrackInfos.length)
                    dispatchMediaStreamEvent(legacyRemoteTrackInfos);
            };

            client.dataChannelsEnabled = function () {
                canCreateDataChannels = true;

                var func;
                while ((func = deferredCreateDataChannelCalls.shift()))
                    func(peerHandler);
            };

            client.dataChannelRequested = function (settings) {
                var dataChannel = new RTCDataChannel(settings, whenPeerHandlerCanCreateDataChannels);
                _this.dispatchEvent({ "type": "datachannel", "channel": dataChannel, "target": _this });
            };

            return client;
        }
    }

    RTCPeerConnection.toString = function () {
        return "[object RTCPeerConnection]";
    };

    function RTCSessionDescription(initDict) {
        checkArguments("RTCSessionDescription", "dictionary", 0, arguments);
        if (initDict) {
            checkDictionary("RTCSessionDescriptionInit", initDict, {
                "type": "string",
                "sdp": "string"
            });
        } else
            initDict = {};

        this.type = initDict.hasOwnProperty("type") ? String(initDict["type"]) : null;
        this.sdp = initDict.hasOwnProperty("sdp") ? String(initDict["sdp"]) : null;

        this.toJSON = function () {
            return { "type": this.type, "sdp": this.sdp };
        };

        this.toString = RTCSessionDescription.toString;
    }

    RTCSessionDescription.toString = function () {
        return "[object RTCSessionDescription]";
    };

    function RTCIceCandidate(initDict) {
        checkArguments("RTCIceCandidate", "dictionary", 0, arguments);
        if (initDict) {
            checkDictionary("RTCIceCandidateInit", initDict, {
                "candidate": "string",
                "sdpMid": "string",
                "sdpMLineIndex": "number"
            });
        } else
            initDict = {};

        this.candidate = initDict.hasOwnProperty("candidate") ? String(initDict["candidate"]) : null;
        this.sdpMid = initDict.hasOwnProperty("sdpMid") ? String(initDict["sdpMid"]) : null;
        this.sdpMLineIndex = parseInt(initDict["sdpMLineIndex"]) || 0;

        this.toJSON = function () {
            return { "candidate": this.candidate, "sdpMid": this.sdpMid, "sdpMLineIndex": this.sdpMLineIndex };
        };

        this.toString = RTCIceCandidate.toString;
    }

    RTCIceCandidate.toString = function () {
        return "[object RTCIceCandidate]";
    };

    //
    // RTCDataChannel
    //
    RTCDataChannel.prototype = Object.create(EventTarget.prototype);
    RTCDataChannel.prototype.constructor = RTCDataChannel;

    function RTCDataChannel(settings, whenPeerHandlerCanCreateDataChannels) {
        var _this = this;
        var internalDataChannel;
        var sendQueue = [];

        EventTarget.call(this, {
            "onopen": null,
            "onerror": null,
            "onclose": null,
            "onmessage": null
        });

        var a = { // attributes
            "label": settings.label,
            "ordered": settings.ordered,
            "maxPacketLifeTime": settings.maxPacketLifeTime,
            "maxRetransmits": settings.maxRetransmits,
            "protocol": settings.protocol,
            "negotiated": settings.negotiated,
            "id": settings.id,
            "readyState": "connecting",
            "bufferedAmount": 0
        };
        domObject.addReadOnlyAttributes(this, a);

        var _binaryType = "blob";
        Object.defineProperty(this, "binaryType", {
            "get": function () { return _binaryType; },
            "set": function (binaryType) {
                if (binaryType !== "blob" && binaryType !== "arraybuffer") {
                    throw createError("TypeMismatchError", "Unknown binary type: " +
                        entityReplace(binaryType));
                }
                _binaryType = binaryType;
            }
        });

        var client = createInternalDataChannelClient();
        var clientRef = bridge.createObjectRef(client, "readyStateChanged", "gotData",
            "setBufferedAmount");

        whenPeerHandlerCanCreateDataChannels(function (peerHandler) {
            peerHandler.createDataChannel(a, clientRef, function (channelInfo) {
                a.id = channelInfo.id;
                internalDataChannel = channelInfo.channel;
            });
        });

        function getDataLength(data) {
            if (data instanceof Blob)
                return data.size;

            if (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
                return (new Uint8Array(data)).byteLength;

            return unescape(encodeURIComponent(data)).length;
        }

        function processSendQueue() {
            if (a.readyState != "open")
                return;

            var data = sendQueue[0];
            if (data instanceof Blob) {
                var reader = new FileReader();
                reader.onloadend = function () {
                    sendQueue[0] = reader.result;
                    processSendQueue();
                };
                reader.readAsArrayBuffer(data);
                return;
            }

            if (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
                internalDataChannel.sendBinary(data);
            else
                internalDataChannel.send(data);

            sendQueue.shift();

            if (sendQueue.length)
                processSendQueue();
        }

        this.send = function (data) {
            checkArguments("send", "string | ArrayBuffer | ArrayBufferView | Blob", 1, arguments);

            if (a.readyState == "connecting")
                throw createError("InvalidStateError", "send: readyState is \"connecting\"");

            a.bufferedAmount += getDataLength(data);

            if (sendQueue.push(data) == 1)
                processSendQueue();
        };

        this.close = function () {
            if (a.readyState == "closing" || a.readyState == "closed")
                return;
            a.readyState = "closing";
            internalDataChannel.close();
        };

        this.toString = RTCDataChannel.toString;

        function createInternalDataChannelClient() {
            var client = {};

            client.readyStateChanged = function (newState) {
                a.readyState = newState;

                var eventType;
                if (a.readyState == "open")
                    eventType = "open";
                else if (a.readyState == "closed")
                    eventType = "close";

                if (eventType)
                    _this.dispatchEvent({ "type": eventType, "target": _this });
            };

            client.setBufferedAmount = function (bufferedAmount) {
                a.bufferedAmount = bufferedAmount + sendQueue.reduce(function (prev, item) {
                    return prev + getDataLength(item);
                }, 0);
            };

            client.gotData = function (data) {
                _this.dispatchEvent({ "type": "message", "data": data, "target": _this });
            };

            return client;
        }
    }

    RTCDataChannel.toString = function () {
        return "[object RTCDataChannel]";
    };

    function MediaStreamURL(mediaStream) {
        if (!MediaStreamURL.nextId)
            MediaStreamURL.nextId = 1;

        var url = "mediastream:" + randomString(36);

        function ensureImgDiv(video) {
            if (video.className.indexOf("owr-video") != -1)
                return video;

            var imgDiv = document.createElement("div");
            imgDiv.__src = url;

            var styleString = "display:inline-block;";
            if (video.width)
                styleString += "width:" + video.width + "px;";
            if (video.height)
                styleString += "height:" + video.height + "px;";

            if (video.ownerDocument.defaultView.getMatchedCSSRules) {
                var rules = video.ownerDocument.defaultView.getMatchedCSSRules(video, "");
                if (rules) {
                    for (var i = 0; i < rules.length; i++)
                        styleString += rules[i].style.cssText;
                }
            }

            var styleElement = document.createElement("style");
            var styleClassName = "owr-video" + MediaStreamURL.nextId++;
            styleElement.innerHTML = "." + styleClassName + " {" + styleString + "}";
            document.head.insertBefore(styleElement, document.head.firstChild);

            for (var p in global) {
                if (global[p] === video)
                    global[p] = imgDiv;
            }

            imgDiv.autoplay = video.autoplay;
            imgDiv.currentTime = 0;

            imgDiv.style.cssText = video.style.cssText;
            imgDiv.id = video.id;
            imgDiv.className = video.className + " owr-video " + styleClassName;

            var img = new Image();
            img.crossOrigin = "anonymous";
            img.style.display = "inline-block";
            img.style.verticalAlign = "middle";
            imgDiv.appendChild(img);

            var ghost = document.createElement("div");
            ghost.style.display = "inline-block";
            ghost.style.height = "100%";
            ghost.style.verticalAlign = "middle";
            imgDiv.appendChild(ghost);

            Object.defineProperty(imgDiv, "src", {
                "get": function () { return url; },
                "set": function (src) {
                    url = String(src);
                    if (!(src instanceof MediaStreamURL))
                        setTimeout(scanVideoElements, 0);
                }
            });

            var videoParent = video.parentNode;
            videoParent.insertBefore(imgDiv, video);
            delete videoParent.removeChild(video);

            if (parseInt(getComputedStyle(imgDiv, null).width))
                img.style.width = "100%";

            return imgDiv;
        }

        function scanVideoElements() {
            var elements = document.querySelectorAll("video, div.owr-video");
            var i;
            for (i = 0; i < elements.length; i++) {
                if (elements[i].src == url && elements[i].__src != url)
                    break;
            }
            if (i == elements.length)
                return;

            var audioSources = mediaStream.getAudioTracks().map(getTrackSource);
            var videoSources = mediaStream.getVideoTracks().map(getTrackSource);

            function getTrackSource(track) {
                return sourceInfoMap[track.id].source;
            }

            var video = elements[i];
            var imgDiv = ensureImgDiv(video);
            var img = imgDiv.firstChild;
            img.style.visibility = "hidden";
            img.src = "";

            var tag = randomString(36);
            var useVideoOverlay = global.navigator.__owrVideoOverlaySupport
                && video.className.indexOf("owr-no-overlay-video") == -1;

            bridge.renderSources(audioSources, videoSources, tag, useVideoOverlay, function (renderInfo) {
                var count = Math.round(Math.random() * 100000);
                var roll = navigator.userAgent.indexOf("(iP") < 0 ? 100 : 1000000;
                var retryTime;
                var initialAttempts = 20;
                var imgUrl;

                if (renderControllerMap[imgDiv.__src]) {
                    renderControllerMap[imgDiv.__src].stop();
                    delete renderControllerMap[imgDiv.__src];
                }
                renderControllerMap[url] = renderInfo.controller;
                imgDiv.__src = url;

                if (renderInfo.port)
                    imgUrl = "http://127.0.0.1:" + renderInfo.port + "/__" + tag + "-";

                img.onload = function () {
                    initialAttempts = 20;
                    if (img.oncomplete)
                        img.oncomplete();
                    imgDiv.videoWidth = img.naturalWidth;
                    imgDiv.videoHeight = img.naturalHeight;
                    imgDiv.currentTime++;

                    if (!retryTime) {
                        img.style.visibility = "visible";
                        retryTime = 500;
                    } else if (shouldAbort())
                        return;

                    img.src = imgUrl + (++count % roll);
                };

                img.onerror = function () {
                    if (retryTime)
                        retryTime += 300
                    else
                        initialAttempts--;
                    if (shouldAbort())
                        return;

                    setTimeout(function () {
                        img.src = imgUrl ? imgUrl + (++count % roll) : "";
                    }, retryTime || 100);
                };

                var muted = video.muted;
                Object.defineProperty(imgDiv, "muted", {
                    "get": function () { return muted; },
                    "set": function (isMuted) {
                        muted = !!isMuted;
                        renderInfo.controller.setAudioMuted(muted);
                    },
                    "configurable": true
                });

                imgDiv.play = function () {
                    imgDiv.muted = imgDiv.muted;
                    if (imgUrl)
                        img.src = imgUrl;
                };
                if (imgDiv.autoplay)
                    imgDiv.play();

                imgDiv.stop = function () {
                    renderControllerMap[imgDiv.__src].stop();
                    delete renderControllerMap[imgDiv.__src];
                }

                 function shouldAbort() {
                    return retryTime > 2000 || !imgDiv.parentNode || initialAttempts < 0;
                }
            });

            function checkIsHidden(elem) {
                if (!elem.parentNode)
                    return elem != document;

                if (elem.style.display == "none" || elem.style.visibility == "hidden")
                    return true;

                return checkIsHidden(elem.parentNode);
            }

            function maybeUpdateVideoOverlay() {
                var isHidden = checkIsHidden(imgDiv);
                var hasChanged = isHidden != maybeUpdateVideoOverlay.oldIsHidden;
                if (isHidden && !hasChanged)
                    return;

                var videoRect;
                if (!isHidden) {
                    var dpr = self.devicePixelRatio;
                    if (window.innerWidth < window.innerHeight)
                        dpr *= screen.width / window.innerWidth;
                    else
                        dpr *= screen.height / window.innerWidth;
                    var bcr = imgDiv.getBoundingClientRect();
                    var scl = document.body.scrollLeft;
                    var sct = document.body.scrollTop;
                    videoRect = [
                        Math.floor((bcr.left + scl) * dpr),
                        Math.floor((bcr.top + sct) * dpr),
                        Math.ceil((bcr.right + scl) * dpr),
                        Math.ceil((bcr.bottom + sct) * dpr)
                    ];
                    for (var i = 0; !hasChanged && i < videoRect.length; i++) {
                        if (videoRect[i] != maybeUpdateVideoOverlay.oldVideoRect[i])
                            hasChanged = true;
                    }
                } else
                    videoRect = [0, 0, 0, 0];

                if (hasChanged) {
                    maybeUpdateVideoOverlay.oldIsHidden = isHidden;
                    maybeUpdateVideoOverlay.oldVideoRect = videoRect;
                    var trackId = mediaStream.getVideoTracks()[0].id;

                    var rotation = 0;
                    var transform = getComputedStyle(imgDiv).webkitTransform;
                    if (!transform.indexOf("matrix(")) {
                        var a = parseFloat(transform.substr(7).split(",")[0]);
                        rotation = Math.acos(a) / Math.PI * 180;
                    }

                    alert("owr-message:video-rect," + (sourceInfoMap[trackId].type == "capture")
                        + "," + tag
                        + "," + videoRect[0] + "," + videoRect[1] + ","
                        + videoRect[2] + "," + videoRect[3] + ","
                        + rotation);
                }
            }
            maybeUpdateVideoOverlay.oldVideoRect = [-1, -1, -1, -1];

            if (useVideoOverlay && mediaStream.getVideoTracks().length > 0)
                setInterval(maybeUpdateVideoOverlay, 500);

        }

        this.toString = function () {
            setTimeout(scanVideoElements, 0);
            return url;
        };
    }

    global.webkitMediaStream = MediaStream;
    global.webkitRTCPeerConnection = RTCPeerConnection;
    global.RTCSessionDescription = RTCSessionDescription;
    global.RTCIceCandidate = RTCIceCandidate;
    global.navigator.webkitGetUserMedia = legacyGetUserMedia;
    if (!global.navigator.mediaDevices)
        global.navigator.mediaDevices = {};
    global.navigator.mediaDevices.getUserMedia = getUserMedia;


    var url = global.webkitURL || global.URL;
    if (!url)
        url = global.URL = {};

    var origCreateObjectURL = url.createObjectURL;
    url.createObjectURL = function (obj) {
        if (obj instanceof MediaStream)
            return new MediaStreamURL(obj);
        else if (origCreateObjectURL)
            return origCreateObjectURL(obj);
       // this will always fail
       checkArguments("createObjectURL", "Blob", 1, arguments);
    };

    Object.defineProperty(HTMLVideoElement.prototype, "srcObject", {
        "get": function () {
            return this._srcObject;
        },
        "set": function (stream) {
            this._srcObject = stream;
            this.src = url.createObjectURL(stream);
        }
    });

    var origDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function () {
        var _this = this;
        var args = Array.apply([], arguments);
        if (args[0] instanceof HTMLDivElement) {
            args[0] = args[0].firstChild;
            if (args[0] && !args[0].complete) {
                if (!args[0].oncomplete) {
                    args[0].oncomplete = function () {
                        args[0].oncomplete = null;
                        origDrawImage.apply(_this, args);
                    };
                }
                return;
            }
        }

        return origDrawImage.apply(_this, args);
    };

})(self);

})();
