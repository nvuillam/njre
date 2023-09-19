## Functions

<dl>
<dt><a href="#followToAdoptium">followToAdoptium()</a></dt>
<dd><p>The API will decide if it needs to redirect from api.adoptopenjdk.net to
api.adoptium.net before finally redirecting to the binary. This function
handles the initial redirection if needed, otherwise it just returns the
location url for the binary.</p>
</dd>
<dt><a href="#install">install([version], [options])</a> ⇒</dt>
<dd><p>Installs a JRE copy for the app</p>
</dd>
</dl>

<a name="followToAdoptium"></a>

## followToAdoptium()
The API will decide if it needs to redirect from api.adoptopenjdk.net to
api.adoptium.net before finally redirecting to the binary. This function
handles the initial redirection if needed, otherwise it just returns the
location url for the binary.

**Kind**: global function  
<a name="install"></a>

## install([version], [options]) ⇒
Installs a JRE copy for the app

**Kind**: global function  
**Returns**: Promise<string> - Resolves to the installation directory or rejects an error  

| Param                  | Type                | Default                          | Description                                                                                    |
|------------------------|---------------------|----------------------------------|------------------------------------------------------------------------------------------------|
| [version]              | <code>number</code> | <code>8</code>                   | Java Version (`8`/`9`/`10`/`11`/`12`)                                                          |
| [options]              | <code>object</code> |                                  | Installation Options                                                                           |
| [options.os]           | <code>string</code> |                                  | Operating System (defaults to current) (`windows`/`mac`/`linux`/`solaris`/`aix`)               |
| [options.arch]         | <code>string</code> |                                  | Architecture (defaults to current) (`x64`/`x32`/`ppc64`/`s390x`/`ppc64le`/`aarch64`/`sparcv9`) |
| [options.openjdk_impl] | <code>string</code> | <code>&quot;hotspot&quot;</code> | OpenJDK Implementation (`hotspot`/`openj9`)                                                    |
| [options.release]      | <code>string</code> | <code>&quot;latest&quot;</code>  | Release                                                                                        |
| [options.type]         | <code>string</code> | <code>&quot;jre&quot;</code>     | Binary Type (`jre`/`jdk`)                                                                      |
| [options.heap_size]    | <code>string</code> |                                  | Heap Size (`normal`/`large`)                                                                   |
| [options.vendor]       | <code>string</code> |                                  | defaults to adoptopenjdk (`adoptopenjdk`/`eclipse`)                                            |

**Example**  
```js
const njre = require('njre')

// Use default options
njre.install()
  .then(dir => {
    // Do stuff
  })
  .catch(err => {
    // Handle the error
  })

// or custom ones
njre.install(11, { os: 'aix', arch: 'ppc64', openjdk_impl: 'openj9' })
  .then(dir => {
    // Do stuff
  })
  .catch(err => {
    // Handle the error
  })
```
