# Recorrido por el código de la pila de análisis sin conexión de LanzadorAPK (en curso) — documento histórico de v0.3.5

> Para quién: ingenieros que van a tomar el proyecto y seguir desarrollando la cadena «APK → icono → acceso directo».
> Forma de lectura: solo leer código + grep de los puntos de llamada, sin ejecutar ningún comando que cambie el estado.
> Versión de referencia: `package.json` version `0.3.5` (electron ^33.4.11, node >=20).
> Todos los `archivo:línea` corresponden a la instantánea del área de trabajo de entonces; si cambias algo, actualízalos de paso.

Archivos recorridos (`src/core/*.js` tiene 29 en total; aquí solo se cubre el grupo de análisis/iconos/asociación/versiones/registros):

| Archivo | Líneas | Función en una frase |
|---|---|---|
| `src/core/zip.js` | 236 | Lector ZIP que solo usa `zlib` (versión en memoria + versión en flujo por fd) |
| `src/core/axml.js` | 167 | Analizador del XML binario de AndroidManifest.xml |
| `src/core/arsc.js` | 233 | Analizador simplificado de resources.arsc (resuelve referencias @0x7f) |
| `src/core/png.js` | 132 | Codificador PNG sin dependencias + icono de marca dibujado por código |
| `src/core/apk.js` | 190 | Entrada principal de metadatos del APK, `parseApk()` |
| `src/core/shortcut.js` | 183 | Generación de ICO de varios tamaños + escritura de .lnk |
| `src/core/assoc.js` | 68 | Asociación de archivos .apk en HKCU |
| `src/core/version.js` | 36 | Comparación de versiones (aparte para evitar dependencias circulares) |
| `src/core/logfile.js` | 52 | Escritura al final + rotación por tamaño (módulo pequeño de registros/utilidades) |
| `src/core/display.js` | 59 | Cálculos puros de adaptación de pantalla (anexo: también del grupo de «utilidades puras») |

---

## 1. `src/core/zip.js`

### Responsabilidad
Lector ZIP mínimo hecho con el `zlib` incluido en Node: solo analiza el directorio central y descomprime entradas sueltas bajo demanda; además hay una versión en flujo basada en descriptor de archivo, pensada para imágenes del sistema de varios GB.

### Interfaz pública
```js
const { ZipArchive, ZipFile } = require('./zip');

new ZipArchive(buffer /*: Buffer, paquete entero */)
  .entries        // Map<string, {name, flags, method, compSize, uncompSize, localOffset}>  ← campo público, se lee desde fuera directamente
  .has(name)      // → boolean
  .names()        // → string[]
  .find(re)       // (RegExp) → string[] (nombres de entradas que coinciden)
  .read(name)     // → Buffer | null (si la entrada no existe devuelve null; con encabezado local dañado/método de compresión no admitido hace throw)
  .pipeTo(name, dest /*: Writable */)  // → Promise<number> (resuelve con el tamaño sin comprimir, para verificar los bytes escritos)

new ZipFile(filePath /*: string */)
  .size           // bytes del archivo
  .entries        // igual que arriba
  .has / .names / .find          // igual que arriba
  .close()        // idempotente; fd pasa a null
  .read(name)     // → Buffer (si no existe hace throw, no devuelve null: ¡distinto de ZipArchive!)
  .pipeTo(name, dest)  // → Promise<number>
```
> Ojo con la asimetría de interfaces: `ZipArchive.read` devuelve `null` si falta la entrada y `ZipFile.read` lanza `la entrada no existe`. El `if (data && ...)` sobre `zip.read(...)` en `apk.js` está por el primero.

### Implementación interna clave

**ZipArchive: lee el paquete entero en memoria (no en flujo)**
- El constructor toma directamente el `Buffer` que le da el llamador (`zip.js:14`) y no toca el disco. Así que «si se lee entero en memoria» depende del llamador: `apk.js:78` usa `fs.readFileSync` y `installer.js:27` también → **la ruta de análisis del APK mantiene el paquete entero en memoria al 100 %**.
- `_parse()` (`zip.js:20`): recorre hacia atrás desde `buf.length-22` buscando `EOCD_SIG`, con límite inferior `buf.length - 65557` (`zip.js:23`, = 22 bytes de EOCD + 65535 bytes de comentario máximo). Al encontrarlo, `total` se toma de `+10` (u16) y el desplazamiento del directorio central de `+16` (u32).
- Bucle del directorio central (`zip.js:32-47`): avanza 46 + nameLen + extraLen + commentLen; los desplazamientos de campo 8/10/20/24/28/30/32/42 siguen la especificación PKZIP; los nombres se decodifican siempre como UTF-8 (`zip.js:42`), **sin tratar el bit 11 de GP flags**.
- `read()` (`zip.js:54`): primero valida la firma `LOC_SIG` del encabezado local y luego calcula el inicio de los datos con nameLen/extraLen del **encabezado local** (`zip.js:61-63`; no se pueden usar las longitudes del directorio central, pueden diferir); `method 0` devuelve `Buffer.from(raw)` (**hace una copia**, `zip.js:65`); `method 8` usa `zlib.inflateRawSync` (`zip.js:66`).
- `pipeTo()` (`zip.js:80`): pasa `raw` en trozos de 1 MB a `createInflateRaw` y, cuando `write()` devuelve false, espera `once('drain')` para seguir (`zip.js:105-116`); `dest.on('finish')` y `dest.on('error')` comparten `done`, y al terminar bien resuelve con `e.uncompSize` (el llamador puede verificar los bytes con eso). **Ojo: los datos ya están en memoria; los trozos solo evitan que zlib trague GB de una vez, no ahorran memoria.**

**ZipFile: fd + ventana final**
- Construcción: `fs.openSync(path,'r')` + `statSync` (`zip.js:134-135`); si `_parse()` falla hace `close()` y luego lanza (`zip.js:137`, evita fugas de fd).
- Solo lee los últimos `min(size, 22 + 65557 + 4096)` bytes (`zip.js:152`, como máximo 69675 B) para buscar el EOCD; si el directorio central no está en esa ventana (comentarios muy largos, etc.), hace aparte `readAt(cdOffset, min(eocdAbs-cdOffset, 64MB))` (`zip.js:166-172`).
- `_readAt` (`zip.js:145`): `Buffer.alloc(len)` + **un solo** `fs.readSync`. POSIX permite lecturas cortas y aquí no hay bucle de reintento → en teoría un directorio central de 64 MB podría truncarse en silencio (con archivos locales de Windows normalmente no pasa; cuidado con discos de red/virtuales).
- `read()` (`zip.js:206`) lee todo el `compSize` en memoria y luego hace inflate: **las entradas grandes siguen chocando con el límite de 2 GB**; solo `pipeTo()` (`zip.js:214`) va en flujo: `createReadStream(null,{fd, autoClose:false, start, end})`, donde `end` es un **intervalo cerrado** (`zip.js:203` ya usa `start+compSize-1`).
- `_range()` (`zip.js:195`) lee cada vez 30 bytes del encabezado local para validar la firma y devuelve `{e,start,end}`.

**En qué líneas está exactamente el límite de 2 GB**
| Ubicación | Significado |
|---|---|
| `zip.js:75-79` (comentario) | Deja claro que «las entradas de varios GB no se pueden inflar de una vez porque chocan con el límite de 2 GB por Buffer de Node»; por eso existe `pipeTo` |
| `zip.js:37` / `zip.js:180` | `uncompSize` y `compSize` se leen con `readUInt32LE` → **no hay Zip64**; las entradas de más de 4 GiB dan valores truncados/con alias |
| `zip.js:29-30` / `161-162` | `total` es u16 (no vale con más de 65535 entradas) y `cdOffset` es u32 (en Zip64 es `0xffffffff`, cae en la rama «desplazamiento anómalo» de `zip.js:166` y lanza) |
| `zip.js:208` | `ZipFile.read()` reserva un Buffer para todo el `compSize` → una entrada de más de 2 GB da directamente `ERR_BUFFER_TOO_LARGE` |
| `apk.js:78` | `readFileSync` del paquete entero → un APK de más de 2 GB (o de más de `buffer.constants.MAX_LENGTH`) falla ya al leer, sin llegar a la capa zip |

### Trampas e invariantes
1. **nameLen/extraLen del encabezado local y del directorio central deben leerse cada uno por separado** (`zip.js:61-63`, `198-202`). Pueden diferir (sobre todo con data descriptor o relleno de alineación), y usar los del directorio central para calcular el inicio de los datos locales es la forma más común de romperlo.
2. **El data descriptor (bit 3 de GP) no necesita trato especial**: como el tamaño comprimido sale del directorio central (`zip.js:36/179`), da igual que esos tres campos del encabezado local sean 0. En esto es más robusto que muchos analizadores ZIP en flujo.
3. **No se comprueba el bit de cifrado**: `flags` solo se guarda (`zip.js:34`) y nunca se mira el bit 0; las entradas cifradas fallan como «inflate falló», con un mensaje que no apunta a la causa real.
4. **Un directorio central truncado pierde entradas en silencio**: el `break` de `zip.js:176` sale directamente con `off+46 > cd.length` o firma incorrecta, sin lanzar. El síntoma es «el APK tiene lib/ pero abis sale vacío».
5. `ZipArchive.entries` es un `Map` público; `apk.js:31`, `apk.js:44` y `provision.js:608` hacen `entries.get(name)` directamente para leer `uncompSize`; cambiar la estructura de datos afecta a los tres.
6. El `dest` de `pipeTo` debe ser un flujo escribible creado por el llamador (`provision.js:611` y `updater.js:239` usan `fs.createWriteStream`); la función no cierra dest, solo espera a `finish`.
7. `ZipFile` debe cerrarse con `close()` al terminar (`provision.js:619` usa `finally`, `updater.js:249` también); si no, hay fuga de fd.
8. Los nombres se decodifican siempre como `utf8`; los ZIP viejos con nombres GBK salen corruptos, pero en los APK las rutas son ASCII y no afecta en la práctica.

### Quién lo llama
`ZipArchive`:
- `src/core/apk.js:8` (require), `apk.js:79` (ruta principal de `parseApk`)
- `src/core/installer.js:12`, `installer.js:27` (`parseBundle`, separa .apks/.xapk)
- `src/core/provision.js:15`, `provision.js:595` (los paquetes pequeños usan la versión en memoria)
- `test/run-tests.js:29`, `57`; `test/run-tests.js:119`, `124` (APK real de prueba)
- `test/engine-test.js:167`, `194`
- `test/auto-test.js:277`, `319`

`ZipFile`:
- `src/core/provision.js:15`, `595` (>64 MB usa la versión desde archivo)
- `src/core/updater.js:21`, `230` (`_extract`, descompresión de la actualización)
- `test/auto-test.js:277`, `320` (comparación de coherencia con `ZipArchive`)

`pipeTo`:
- `src/core/provision.js:611`, `src/core/updater.js:239`, `src/core/zip.js:80` (el propio)

### Cobertura de pruebas
- `test/run-tests.js:30` «puede analizar la estructura de un zip con el package.json del propio proyecto»: el nombre impresiona, pero en realidad arma a mano un zip stored mínimo (`run-tests.js:32-57`) y solo cubre `has` + `read`.
- `test/engine-test.js:166` «la descompresión ZIP incluida funciona»: cubre indirectamente `ZipArchive` + `pipeTo` a través de `Provisioner.extractZip` (`provision.js:591`).
- `test/auto-test.js:275` «ZipFile y ZipArchive analizan igual el mismo paquete (con deflate y pipeTo en flujo)»: el único caso que prueba a la vez stored/deflate, `read`/`pipeTo` y las dos clases; `auto-test.js:278-315` arma los bytes a mano.
- **Huecos**: no hay casos de Zip64, de «directorio central truncado», del bit de cifrado ni de `find()`; la ruta de entradas grandes de `ZipFile.read()` no tiene cobertura.

---

## 2. `src/core/axml.js`

### Responsabilidad
Analiza el `AndroidManifest.xml` compilado del APK (XML binario / AXML) como un árbol DOM normal, para que las capas superiores consulten por etiqueta/atributo.

### Interfaz pública
```js
const { parseAxml, attr, attrValue, children, ANDROID_NS, TYPE_REFERENCE } = require('./axml');

parseAxml(buffer /*: Buffer */)   // → node (la raíz es manifest; si no es AXML o el manifiesto está vacío hace throw)
// node = { name: string, attrs: Attr[], children: node[], parent: node|null }
// Attr = {
//   ns: string,        // '' significa sin espacio de nombres (nsIdx = 0xffffffff)
//   prefix: string,    // lo mantienen los eventos start/end de espacio de nombres; se obtiene el prefix «declarado por último»
//   name: string,      // nombre del atributo (pool de cadenas)
//   value: string|number|boolean|null,  // primero rawValue, luego según dataType
//   refId: number|null,   // solo tiene valor con dataType=TYPE_REFERENCE(0x01) (sin signo)
//   dataType: number,  // valor original de Res_value.dataType
//   typed: string|number|boolean|null,  // null si es referencia; en el resto, igual que value
// }

attr(node, name, ns = ANDROID_NS)   // → Attr | null; ns null significa sin restricción de espacio de nombres
attrValue(node, name, ns = ANDROID_NS)  // → Attr.typed | null
children(node, name)                // → node[] (filtra por nombre de etiqueta, sin recursión)
ANDROID_NS = 'http://schemas.android.com/apk/res/android'
TYPE_REFERENCE = 0x01
```

### Implementación interna clave

**`readStringPool(buf, start)` (`axml.js:26-62`)**
- Encabezado: `type@0`, `headerSize@2`, `chunkSize@4`, `count@8`, `flags@16`, `stringsStart@20`; `isUtf8 = flags & 0x100` (`axml.js:34`).
- La tabla de desplazamientos va justo tras el encabezado: `start + headerSize + i*4` (`axml.js:38`); la base de las cadenas es `start + stringsStart` (`axml.js:40`).
- El pool UTF-8 lee **dos** longitudes variables: primero la «longitud UTF-16» (1~2 bytes, `axml.js:47-48`) y luego la «longitud en bytes UTF-8» (`axml.js:50-51`), y corta con **la segunda**. El pool UTF-16 tiene una longitud de 1~2 u16, en unidades de código (corta `len*2`, `axml.js:58`).
- Devuelve `{ strings, chunkSize }`; el llamador solo toma `strings` (`axml.js:88`).

**`parseAxml(buffer)` (`axml.js:67-150`)**
- Valida el encabezado `RES_XML_TYPE(0x0003)` (`axml.js:69`), `pos = readUInt16LE(2)` (headerSize), `total = readUInt32LE(4)` (`axml.js:72-73`).
- Bucle chunk a chunk `while (pos + 8 <= total && pos < buf.length)` (`axml.js:81`), lee `type/headerSize/chunkSize`; con `chunkSize <= 0` hace `break` para evitar un bucle infinito (`axml.js:85`).
- Espacios de nombres: `nsStack` guarda uri y `prefixByUri` registra uri→prefix (`axml.js:76-77`); en START hace push + set, en END solo pop (`axml.js:89-97`). **Si una misma uri se declara varias veces, el prefix «posterior sobrescribe al anterior»**; `prefixByUri` nunca se limpia.
- START_ELEMENT (`axml.js:98`):
  ```js
  nameIdx   = readUInt32LE(pos + 20)
  attrStart = readUInt16LE(pos + 24)   // desplazamiento relativo a ResXMLTree_attrExt
  attrSize  = readUInt16LE(pos + 26)   // tamaño de un atributo, normalmente 20
  attrCount = readUInt16LE(pos + 28)
  const attrBase = pos + 16 + attrStart;   // ★ axml.js:106
  ```
- Cada atributo ocupa 20 bytes: `ns@0`, `name@4`, `rawValue@8`, `value.size@12`, `value.res0@14`, `value.dataType@15`, `value.data@16` (`axml.js:109-113`).
- Orden de valores: **si existe rawValue se usa la cadena del pool** (`axml.js:120-121`) → si no, `TYPE_STRING` usa `data` como índice del pool (`122-123`) → `TYPE_REFERENCE` solo guarda `refId` (`124-126`) → boolean (`127-128`) → dec/hex (`129-130`, `| 0` lo pasa a 32 bits con signo).
- Construcción del árbol: el nodo nuevo apunta con `parent` a la cima de la pila; tras agregarse al padre entra en la pila (`axml.js:104`, `139-140`); END_ELEMENT solo saca un nivel (`141-142`).
- Final: busca en `root.children` el llamado `manifest` y, si no está, toma el primero (`axml.js:147`); si no hay ninguno lanza «el manifiesto del APK está vacío» (`148`).

### Trampas e invariantes

1. **La base de `attributeStart` (`axml.js:105-106`) es la línea más fácil de romper de todo el archivo.**
   El encabezado `ResXMLTree_node` mide 16 bytes (type 2 + headerSize 2 + chunkSize 4 + lineNumber 4 + comment 4); `ResXMLTree_attrExt` empieza en chunk+16, y `attributeStart` es un **desplazamiento relativo a attrExt** (normalmente 20 = el sizeof de attrExt). Así que la fórmula correcta es `pos + 16 + attrStart`.
   Cambiarla a `pos + attrStart` o `pos + headerSize + attrStart` no falla, solo **obtiene en silencio nombres de atributo/espacios de nombres desplazados**; por fuera se ve como: el nombre de la app vuelve al nombre del paquete, el icono usa el respaldo heurístico y `package` queda `undefined`. Hoy **no hay ninguna aserción ni caso de bytes sintéticos** que lo proteja.

2. **El atributo `package` no tiene espacio de nombres**: `apk.js:88` solo lo obtiene con `attrValue(manifest,'package',null)`; la rama `ns===null` de `attr()` (`axml.js:154`) existe justo para esto.

3. **Hay que probar `rawValue` y `dataType`**: `android:label`, `android:name` y similares suelen tener `rawValue = 0xffffffff` con `dataType = 0x03`; leyendo solo raw se obtiene null. Al revés, algunas cadenas de herramientas escriben raw sin tipo, así que el orden no puede invertirse.

4. **La diferencia entre `typed` y `value` es intencionada**: si existe `refId`, `typed = null` (`axml.js:136`), para que `attrValue()` no devuelva «el número de id de recurso» como cadena. Toda la lógica superior (`apk.js:111`, `apk.js:141`) mira primero `refId` y luego `typed`.

5. **No hay protección para `chunkSize < 8`** (solo `<= 0`, `axml.js:85`); un AXML malformado podría en teoría girar en el sitio; en APK no ocurre, pero habría que agregarlo si en el futuro se analizan archivos arbitrarios subidos por el usuario.

6. **Los chunks no admitidos se omiten en silencio**: CDATA (0x0104) no tiene rama y se salta con `pos += chunkSize` (`axml.js:144`). `RES_XML_RESOURCE_MAP(0x0180)` también se salta, así que el nombre del atributo sale del pool de cadenas y no del attr id del resource map. Para este proyecto basta (busca por nombre), pero **con otros idiomas/resources los nombres de atributo pueden ofuscarse como `a`/`b`** (pasa con APK protegidos/con recursos ofuscados; entonces solo queda buscar por el id del resource map).

7. Solo se analiza el subárbol `manifest`; los nodos hermanos tras el END del espacio de nombres ya no importan.

### Quién lo llama
- `parseAxml`: `src/core/apk.js:9` (require), `apk.js:86` (manifiesto), `apk.js:54` (el XML de iconos adaptativos también reutiliza el mismo analizador)
- `attr`: `src/core/apk.js:62` (`attr(node,'drawable')`)
- `attrValue`: `apk.js:18`, `19` (action/category de intent-filter), `88`, `91`, `92`, `96`, `97`, `124`, `125`
- `children`: `apk.js:16`, `19`, `95`, `99`, `121`
- `ANDROID_NS`: **solo se importa en `apk.js:9`, sin usarse** (import muerto); quien lo usa de verdad es el parámetro por defecto de `attr()` (`axml.js:152`)
- Pruebas: `test/run-tests.js:80` (require), `run-tests.js:120`
- Ningún otro módulo lo consume directamente (`arsc.js` tiene su propio pool de cadenas)

### Cobertura de pruebas
- `test/run-tests.js:118` «el nodo raíz AXML es manifest»: **depende de un APK real de prueba** (`run-tests.js:86-100` busca `LANZADORAPK_TEST_APK` / `test/fixtures/sample.apk` / `Documents/*.apk`); si no lo encuentra se omite todo (`run-tests.js:130-132`).
- No hay casos AXML a nivel de bytes sintéticos → en máquinas sin APK de prueba (CI) `axml.js` tiene cobertura cero y errores de desplazamiento como el de `attributeStart` no se detectan.
- Las exportaciones `attr` / `attrValue` / `children` / `ANDROID_NS` / `TYPE_REFERENCE` no tienen pruebas unitarias directas.

---

## 3. `src/core/arsc.js`

### Responsabilidad
Analizador simplificado de `resources.arsc`: convierte las referencias de recursos `@0x7f...` del manifiesto en la cadena del nombre de la app y la ruta del archivo de icono.

### Interfaz pública
```js
const { ResTable, TYPE_REFERENCE } = require('./arsc');

new ResTable(buffer /*: Buffer, todo el resources.arsc */)
  .globalStrings   // string[]: pool de cadenas a nivel de archivo (value.data es un índice de aquí)
  .packages        // Array<{ id:number, typeStrings:string[], keyStrings:string[],
                   //         types: Map<number /*typeId*/, Array<{id, config, entries: Map<number, {dataType,data} >}>> }>
  .resolve(ref /*: number, 0xPPTTEEEE*/, prefer /*: 'string'|'file'|'any' = 'any' */, depth = 0)
                   // → string | number | boolean | null
TYPE_REFERENCE = 0x01   // se exporta pero no lo usa nadie fuera dentro del proyecto
```

### Implementación interna clave

**Estructura de tres niveles (`arsc.js:9-15`)**
`ResTable`(0x0002) → `ResTable_package`(0x0200) → `ResTable_type`(0x0201). `RES_TABLE_TYPE_SPEC_TYPE`(0x0202) tiene constante pero nunca se procesa.

**`readStringPool(buf,start)` (`arsc.js:23-46`)**
Es **la misma lógica copiada y pegada** de `axml.js:26` (dos ramas UTF-8/UTF-16, dos longitudes varint). Hay que mantener las dos a la vez.

**`_parse()` (`arsc.js:87-106`)**
- Valida `RES_TABLE_TYPE` (`89`), `total@+4`, `pkgCount@+8` (se lee pero en el bucle solo controla `pos<total`; `pkgCount` no se usa para contar).
- Solo el **primer** pool de cadenas se toma como `globalStrings` (condición `this.globalStrings.length === 0` en `99-100`), así los pools de los paquetes no se confunden con el global.

**`_parsePackage(start,size)` (`arsc.js:108-139`)**
- Campos: `id@+8`, `typeStrings@+268`, `keyStrings@+276`, `headerSize@+2` (`111-113`): es la disposición fija de `ResTable_package` (name[128] en UTF-16 ocupa 12..268).
- La lectura de los dos pools de cadenas va dentro de un `try/catch` (`117-120`); si falla solo se pierden los nombres de tipo/clave y **no afecta a `resolve`** (es una tolerancia intencionada; invariante abajo).
- Bucle de subchunks `while (pos + 8 <= end)`, solo procesa `RES_TABLE_TYPE_TYPE` (`125-137`) y los agrupa por `typeId` en `Map<number, chunk[]>` (cada config del mismo typeId ocupa un elemento).

**`_parseType(start)` (`arsc.js:141-179`)**
- Encabezado: `headerSize@+2`, `id@+8` (u8), `flags@+9` (u8), `entryCount@+12` (u32), `entriesStart@+16` (u32), `config@+20`.
- La tabla de desplazamientos empieza en `start + headerSize` y los datos de las entradas en `start + entriesStart` (`151-152`).
- Tres codificaciones:
  - `FLAG_SPARSE(0x01)`: cada elemento 4 bytes `{idx:u16, offset:u16}`, **offset en unidades de 4 bytes** (el `*4` de `157-158`)
  - `FLAG_OFFSET16(0x02)`: `offset:u16`, `0xffff` significa vacío, **también `*4`** (`165-167`)
  - Normal: `offset:u32`, `0xffffffff` significa vacío (`172-173`)
- Los tres `*4` son la codificación compact entry de Android; si se quitan, todo queda desplazado.

**`_readValue(at)` (`arsc.js:181-192`)**
- `ResTable_entry`: `size@0` (u16), `flags@2` (u16); `flags & 0x0001` = `FLAG_COMPLEX` (bag/map; estilos, arreglos y attr están aquí) → **devuelve null directamente** (`186`).
- `valueAt = at + entrySize` (`187`, entrySize puede ser 8 o 16); `dataType@+3` y `data@+4` de `Res_value` (`189-190`).
- No se valida `Res_value.size` (por convención 8), ni hay comprobación de límites más allá de `at+8` (solo en `183`).

**`parseConfig` / `score`**
- Disposición de `ResTable_config`: `size@0`, `imsi@4`, `locale(language@8,country@10)`, `screenType(orientation@12,touchscreen@13,**density@14**)`, `input@16`, `screenSize@20`, `version(**sdkVersion@24**)`, `screenConfig(screenLayout@28,**uiMode@29**)` (`48-59`).
- `isDefault = !language && !country && density===0 && !sdkVersion` (`60`): **no tiene en cuenta `uiMode`**, así que una config con solo `uiMode` se toma como default.
- Puntuación (`65-77`):
  - `prefer='file'`: `s += density` (primero la densidad alta); `anydpi(0xfffe)` resta además `-500` (para no obtener el icono adaptativo xml, comentario en `69`)
  - Otros: primero sin densidad; `language` −40, `sdkVersion/1000`, `uiMode` −20 (es decir, prefiere la config por defecto «sin idioma, sdk bajo, sin uiMode»)

**`resolve(ref,prefer,depth)` (`arsc.js:200-230`)**
- Con `depth > 6` o `ref` 0 devuelve null (evita referencias circulares, `201`).
- Separa `pkgId = ref>>>24`, `typeId = (ref>>>16)&0xff`, `entryIdx = ref&0xffff` (`202-204`).
- **Si no encuentra el paquete recurre a `packages[0]`** (`206`): en APK con varios paquetes (bibliotecas compartidas 0x02/0x03) puede buscar en el paquete equivocado.
- De todas las config del mismo typeId elige la de mayor `score` (`211-217`).
- `TYPE_STRING` → `globalStrings[data]` (`220-222`, undefined devuelve null); `TYPE_REFERENCE` → recursión (`224-226`); boolean/dec/hex se devuelven directamente (`227-228`); el resto null (como `TYPE_DIMENSION` o colores, que aquí no se analizan).

### Trampas e invariantes

1. **`globalStrings` debe ser el pool de nivel de archivo**: `value.data` es un índice del pool global; los `typeStrings/keyStrings` del paquete solo sirven para mostrar en depuración. Por eso es seguro que el `try/catch` de `_parsePackage` trague errores: `resolve` no depende de él. **Al cambiar el código no hagas que `resolve` use `keyStrings`.**
2. **Las constantes de `score()` son empíricas**: `anydpi` resta 500 y `language` resta 40. El objetivo es que «las apps en chino tomen primero los recursos por defecto y el icono tome la densidad más alta»; el precio es que **el nombre de la app puede salir en inglés** (`values/` es el default y `values-zh/` pierde puntos). Por ahora solo busca «poder mostrar algo», sin coincidir con el idioma del sistema.
3. **Los recursos `FLAG_COMPLEX` nunca se obtienen**: si `android:icon` apunta a un recurso bag como `<bitmap>`/`<shape>` devuelve null y se cae en el respaldo heurístico de `apk.js`.
4. **El `*4` de los desplazamientos dispersos/de 16 bits no se puede omitir** (`158`, `167`).
5. **`pkgCount` se lee y no se usa** (`92`): el recorrido de chunks de nivel superior depende de `pos<total`; si el archivo trae chunks que no son paquetes no falla, pero `pkgCount` es una variable muerta.
6. No hay `ResTable_typeSpec`, ni overlayable/staged alias, ni coincidencia de locale, ni paquetes dinámicos `0x00`.
7. La constante `TYPE_REFERENCE` se exporta pero nadie la usa (`arsc.js:233`); es ruido en la API.

### Quién lo llama
- `ResTable`: `src/core/apk.js:10` (require), `apk.js:104` (se construye dentro de un `try/catch`; si falla degrada a `res=null`)
- `resolve`: `apk.js:65` (`drawable` del icono adaptativo), `apk.js:111` (`label`, `'string'`), `apk.js:141` (`icon`/`roundIcon`, `'file'`), `arsc.js:225` (recursión propia)
- Pruebas: `test/run-tests.js:81` (require), `run-tests.js:126`
- `TYPE_REFERENCE`: ningún consumidor en todo el proyecto

### Cobertura de pruebas
- `test/run-tests.js:123` «resources.arsc se puede analizar»: solo afirma `res.packages.length > 0`; también depende del APK real de prueba y se omite si no está.
- No hay casos de `resolve()` (ninguna aserción de que «una ref dé la cadena/ruta esperada»), ni de FLAG_SPARSE / FLAG_OFFSET16 / FLAG_COMPLEX.
- Conclusión: **en esta cadena `arsc.js` es el que tiene las pruebas más flojas**, y la lógica más difícil (tres codificaciones de entry + puntuación de config).

---

## 4. `src/core/png.js`

### Responsabilidad
**Codificador** PNG sin dependencias + dibujo por código del icono de marca de LanzadorAPK (para no meter binarios en el repositorio y poder cambiar el color del tema fácilmente).

> Ojo con la dirección: solo codifica (RGBA → PNG), **no decodifica**. Decodificar WebP/PNG depende por completo de `nativeImage` de Electron / Chromium (ver sección 6).

### Interfaz pública
```js
const { encodePng, drawAppIcon } = require('./png');

encodePng(width, height, rgba /*: Uint8Array, longitud = w*h*4, orden RGBA */)  // → Buffer(PNG)
drawAppIcon(size = 256)  // → Buffer(PNG), size×size
```

### Implementación interna clave
- **CRC32** (`png.js:8-22`): polinomio reflejado estándar `0xedb88320`, tabla de 256 elementos en `Int32Array`; `crc32()` devuelve el valor sin signo con `>>> 0`.
- **chunk()** (`png.js:24-31`): `[len BE][type ascii][data][crc BE]`; el CRC cubre type+data.
- **`encodePng`** (`png.js:34-55`):
  - IHDR de 13 bytes: `width/height` BE, bitDepth=8, colorType=6 (RGBA), compression/filter/interlace todos 0 (`png.js:36-40`)
  - Datos crudos `raw = (width*4+1)*height`; el primer byte de cada fila es filter 0 (None) y el resto se copia con `Buffer.from(rgba.buffer, byteOffset + y*stride, stride)` (`png.js:43-48`): **exige que el `byteOffset` de `rgba` sea válido**; también vale pasar una vista `Uint8ClampedArray`
  - Un solo IDAT, `zlib.deflateSync(raw, {level:9})` (`png.js:52`); con `level:9`, 256×256 tarda unas decenas de milisegundos
- **`drawAppIcon`** (`png.js:80-130`):
  - Supermuestreo 4×: `SS=4`, `S=size*4`; `acc = Float32Array(size*size*4)` acumula el color (`png.js:83`)
  - Formas: rectángulo redondeado con `pad = 6%` y radio `24%` (`85-86`), decidido con `roundRectAlpha()` (`59-65`, «se lleva el punto al rectángulo interior y se mide la distancia al centro del círculo más cercano»); triángulo con `pointInTriangle()` (`67-74`, dentro si los tres productos cruzados tienen el mismo signo)
  - Colores: degradado diagonal `t = (x/S)*0.6 + (y/S)*0.4` → `r 20..34 / g 26..44 / b 33..57`; triángulo de color sólido `#3ddc84` = (61,220,132) (`105-111`)
  - El muestreo solo acumula muestras dentro de la caja (`if (!inBox) continue;` en `102`); fuera, alpha queda en 0; al final se divide todo entre `n = SS*SS = 16` (`122-127`) → los bordes tienen una cobertura de 0..255, es decir, antialiasing
- **Límites de rendimiento**: `size=256` → `S=1024`, 1.048.576 iteraciones, cada una con 1~2 comprobaciones geométricas; una llamada tarda del orden de 5–15 ms. `size=512` son 4M iteraciones (unas 4 veces más). `main.js:175` calcula `ICON_PNG` una vez al iniciar y lo guarda, así que no es una ruta caliente.

### Trampas e invariantes
1. **`acc` debe ser `Float32Array`**: al acumular 16 muestras, `Uint8Array` desbordaría/se truncaría a 255 y saldrían manchas de color. Uint16 también serviría, pero hay que ajustar a la vez la línea de la división.
2. `encodePng` supone `rgba.length >= w*h*4`, **sin validar la longitud**; si es corto `copy` lanza RangeError, y si es largo se ignora el sobrante.
3. Solo admite RGBA8 / filter 0 / un único IDAT: es un codificador «suficiente»; para optimizar con filtros (Paeth) habría que reescribir el bucle que llena `raw`.
4. Las coordenadas de `drawAppIcon` son todas relativas a `S` (el espacio supermuestreado); cambiar `SS` no altera la composición y cambiar `size` solo afecta a la nitidez/tiempo.
5. Es el origen del «icono provisional de marca» y también la entrada del tercer nivel de respaldo de `iconToIco` (`shortcut.js:128-129`); así que en **cualquier caso en que falle la extracción del icono**, el usuario ve en su escritorio este triángulo verde.

### Quién lo llama
- `drawAppIcon`: `src/main.js:15` (require), `main.js:28` (respaldo de `loadBrandIcon()`, cuando no existe `LOGO_FILE`)
- `src/core/shortcut.js:128` (require), `129` (ICO provisional)
- `encodePng`: solo `png.js:129` (dentro de `drawAppIcon`) + pruebas
- Pruebas: `test/run-tests.js:63` (require), `66`, `73`; `test/auto-test.js:496`, `497`; `test/electron-integration.js:22`, `27`

### Cobertura de pruebas
- `test/run-tests.js:64` «el codificador PNG produce firma e IHDR válidos»: comprueba la firma `0x89 0x50`, `IHDR` y longitud > 50; **no verifica el CRC ni los píxeles**.
- `test/run-tests.js:71` «el icono de la app puede dibujarse en cualquier tamaño»: con 16/32/64/256 el ancho de salida coincide con el parámetro.
- `test/auto-test.js:494` usa indirectamente `drawAppIcon(64)` como material PNG-in-ICO.
- Hueco: no hay ninguna aserción sobre la **corrección de los píxeles** de `drawAppIcon` (solo el tamaño); no se prueban entradas con tamaños/longitudes anómalos en `encodePng`.

---

## 5. `src/core/apk.js` (entrada principal)

### Responsabilidad
Extrae sin conexión los metadatos del APK: nombre de paquete / versión / nombre de la app / Activity de inicio / icono / ABI. No depende de aapt, adb ni red.

### Interfaz pública
```js
const { parseApk, quickCheck } = require('./apk');

parseApk(filePath /*: string */) → {
  ok: true,
  filePath,          // se devuelve tal cual
  sizeBytes,         // el size de fs.statSync
  package: string,   // obligatorio; si no, throw
  label: string,     // espacios colapsados + trim + recorte a 60 caracteres
  versionName: string,   // por defecto '1.0'
  versionCode: number,   // 0 si no es number
  minSdk: number,        // por defecto 0
  targetSdk: number,     // por defecto 0
  launchActivity: string|null,
  abis: string[],        // ['arm64-v8a', ...]; [] si no hay lib/
  iconPng: Buffer|null,  // bytes originales del icono (¡PNG o WebP! el nombre del campo confunde)
  iconFile: string|null, // ruta dentro del APK, como 'res/mipmap-xxxhdpi-v4/ic_launcher.png'
}   // si falla siempre hace throw (no devuelve ok:false)

quickCheck(filePath /*: string */) → boolean   // solo lee los 4 primeros bytes para ver 'PK'; ante cualquier excepción devuelve false
```

### Implementación interna clave (`parseApk`, `apk.js:75-175`)

1. `fs.statSync` → con `size < 1024` lanza «archivo demasiado pequeño» (`76-77`).
2. `const buf = fs.readFileSync(filePath)` (`78`) → **el paquete entero en memoria**; es el paso más pesado de toda la cadena.
3. `new ZipArchive(buf)` (`79`).
4. Debe existir `AndroidManifest.xml`; si no, indica «puede ser un paquete dividido .apks/.xapk» (`81-83`).
5. `zip.read` + `parseAxml` (`85-86`).
6. `package`: **primero se busca sin espacio de nombres** (`88`, `attrValue(manifest,'package',null)`) y luego con el espacio de nombres por defecto (como respaldo).
7. `versionName` por defecto `'1.0'`; `versionCode` solo acepta number (`91-93`).
8. `minSdkVersion` / `targetSdkVersion` de `uses-sdk` se normalizan con `| 0` (`95-97`): `null | 0 === 0`.
9. Del nodo `application` se toma el primero, con un objeto vacío de respaldo (`99`).
10. Tabla de recursos: `ResTable` solo se construye si hay `resources.arsc`, **todo dentro de try/catch** (`103-105`) → si arsc está dañado `res=null`, y todas las resoluciones de `refId` fallan y caen solas en los valores por defecto.
11. Nombre de la app (`108-117`): `attr(app,'label')` → `res.resolve(refId,'string')` → si no, `typed` si es string → si no, **el último tramo del nombre del paquete con mayúscula inicial**.
12. Activity de inicio (`120-134`):
    - Candidatas = `activity` + `activity-alias` (`121`)
    - `isLauncherActivity` (`15-25`): **dentro del mismo `intent-filter`** deben estar a la vez `android.intent.action.MAIN` y `android.intent.category.LAUNCHER` (no vale combinar filtros distintos)
    - Completar el nombre: si empieza por `.` → `package + n`; si no tiene `.` → `package.n`; si no, tal cual (`127-129`)
    - Con `activity-alias` y `targetActivity` se **sustituye** por el target (`130-132`; se decide por el nombre de nodo `launcher.name === 'activity-alias'`)
13. Icono (`137-152`): primero `icon` y de respaldo `roundIcon` (`138`) → `res.resolve(refId,'file')` o la cadena `typed` → se valida con `zip.has(file)` → `.xml` va por `iconFromAdaptiveXml`; si no, `zip.read(file)` directo → al final, si `!icon`, `pickIconFromZip`.
14. ABI (`155-158`): de las entradas con prefijo `lib/` se toma el 2.º segmento sin duplicados.
15. Objeto devuelto (`160-174`).

**`iconFromAdaptiveXml(zip, xmlBuffer, res)` (`apk.js:51-73`)**
- Analiza el XML del icono adaptativo y busca **hijos directos** en el orden `['foreground','background','monochrome']` (`58-60`); también acepta que la raíz sea uno de ellos (segunda mitad de `60`)
- Toma `android:drawable`: `refId` → `res.resolve(...,'file')`; si no, la cadena `typed` (`62-66`)
- **Solo acepta `.png`/`.webp`** (`67`), con `zip.has(file)` obligatorio (`68`), y solo devuelve si `data.length > 100` (`70`)
- No entra en `<inset>`, `<layer-list>` ni `<bitmap>`; si falla el análisis del propio XML devuelve null (`53-57`)

**`pickIconFromZip(zip)` (`apk.js:27-48`, respaldo heurístico)**
- Candidatas: `/^res\/.*\.(png|webp)$/i` (`29`)
- Puntuación = `entries.get(n).uncompSize`, **bytes sin comprimir** (no el tamaño en píxeles), multiplicado por un peso según el nombre:
  - `ic_launcher|app_icon|ic_app` ×6 (`33`)
  - `_round|_foreground|_background` ×0,4 (`34`)
  - `xxxhdpi` ×1,6 / `xxhdpi` ×1,4 / `xhdpi` ×1,2 (`35-37`)
- Tras ordenar de mayor a menor solo prueba las 30 primeras (`41`); acepta si `data.length > 100` (`44`), si no null.

### Trampas e invariantes
1. **`readFileSync` del paquete entero (`apk.js:78`)**: analizar un APK de 500 MB hace que el proceso ocupe 500 MB más de memoria residente; con `>2GB` da directamente `ERR_FS_FILE_TOO_LARGE`. Con `.apks`/`.xapk` por `installer.parseBundle` es peor (el ZIP exterior también se lee entero, luego cada split se escribe a disco y se hace `parseApk` de cada uno).
2. **El nombre del campo `iconPng` engaña**: `apk.js:172` devuelve los **bytes originales del icono**, que pueden ser WebP (`res/mipmap-*/ic_launcher.webp`). Por eso `shortcut.iconToIco` necesita tres niveles de respaldo, y `installer.js:208-209` lo guarda como `.png`: «nombre .png, contenido quizá WebP»; Chromium/nativeImage lo leen por el número mágico y se ve, pero con herramientas externas no coincide.
3. **`launchActivity` es solo «lo que declara el APK»**: `installer.js:227-234` comenta claramente que «la Activity principal obtenida del APK muchas veces no es la entrada LAUNCHER real»; tras instalar se sustituye con `client.resolveLauncher(pkg)`. **No agregues lógica de inicio aquí.**
4. **Manejo del target de `activity-alias`**: `130-132` usa `launcher.name` (nombre de etiqueta); si una misma activity tiene alias y declaración real y ambas coinciden, se toma la que se encuentra primero; el orden es `activity` primero y `activity-alias` después (`121`).
5. **`apk.js:38` de `pickIconFromZip`** es código muerto heredado: `if (/\//.test(n.split('/')[1] || '')) { /* noop */ }` no hace nada y se puede borrar sin riesgo.
6. **La puntuación usa `uncompSize`**: una imagen «muy comprimible y con muchos píxeles» (una pantalla de inicio de color sólido) puede quedar detrás por ocupar poco comprimida; un icono de color sólido puede quedar delante de una foto. Es un defecto natural de la heurística.
7. **Respaldo de `label`**: `a.b.c` → `C`, así que el paquete `com.example.game` se muestra como `Game`. Una app en chino, si falla el análisis de arsc, degrada al segmento en inglés; es una degradación aceptable.
8. **Con `res` en null no se lanza error**: `label`/`icon` vuelven a los valores por defecto; esta ruta tolerante hace que «el analizador ARSC está roto» se vea como «el icono es feo y el nombre está en inglés», en vez de un error. Al investigar, mira primero si `iconFile` lo eligió el respaldo.
9. `quickCheck` (`178-188`) **no tiene ningún llamador en `src/`** (solo lo usan las pruebas): es código muerto; el canal IPC `apk:parse` (`main.js:756`) solo lo expone `preload.js:10` y `src/ui/app.js` no lo usa (la interfaz va por `installApk`, `ui/app.js:484`).

### Quién lo llama
- `parseApk`:
  - `src/main.js:14` (require), `main.js:756` (IPC `apk:parse`)
  - `src/preload.js:10` (`window.lanzadorapk.parseApk`)
  - `src/core/installer.js:11` (require), `installer.js:40` (busca base en el paquete dividido), `installer.js:149` (ruta principal de instalación)
  - `scripts/selftest.js:18`, `142`
  - Pruebas: `test/run-tests.js:82`, `106`; `test/electron-integration.js:24`, `55`
- `quickCheck`: **solo se usa en `test/run-tests.js:103-104`**
- Indirecto (`installer.install`): `src/main.js:758` (IPC `apk:install`) ← `src/ui/app.js:484`

### Cobertura de pruebas
- `test/run-tests.js:103` «quickCheck reconoce el encabezado PK»
- `test/run-tests.js:107` «obtiene nombre de paquete / versión / Activity de inicio»: afirma que `package` coincide con `^[\w.]+$`, que hay `versionName` y que `launchActivity` contiene `.`
- `test/run-tests.js:113` «obtiene un icono utilizable»: `iconPng.length > 100` y `label` no vacío
- Las tres **dependen de un APK real de prueba**; sin él se omite todo (`run-tests.js:130-132`) → en CI es como no probarlo
- `test/electron-integration.js:54-62` hace «icono del APK → ICO de varios tamaños» con un APK real; si falla el registro dice «el icono quizá tiene un formato distinto de webp/jpg»
- Huecos: `.apks`/`.xapk` (`installer.parseBundle`) no tienen ningún caso; no se prueban casos negativos de `activity-alias`, sin arsc o sin icono

---

## 6. `src/core/shortcut.js`

### Responsabilidad
Convierte el icono del APK en un ICO de varios tamaños y escribe los `.lnk` del escritorio/menú Inicio de Windows; tres niveles de respaldo garantizan que el acceso directo **siempre** tenga icono.

### Interfaz pública
```js
const {
  pngToIco, pngBytesToIco, iconToIco,
  writeShortcut, removeShortcut, safeFileName, ICO_SIZES,
} = require('./shortcut');

ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]   // 9 tamaños; se exporta pero nadie lo usa fuera dentro del proyecto

pngToIco(pngBuffer)                  // → Buffer(ICO, DIB de varios tamaños) | null; ★ hace require('electron') dentro; en Node puro lanza TypeError
pngBytesToIco(png)                   // → Buffer(ICO, PNG-in-ICO de un tamaño) | null; funciona en Node puro
iconToIco(raw, { decode } = {})      // async → Buffer(ICO) | null; tres niveles de respaldo
writeShortcut({                      // → string (el shortcutPath escrito)
  shortcutPath, target, args?, iconIcoPath?, description?, cwd?, appUserModelId?,
})                                   // si falla hace throw (los tres textos de error, abajo)
removeShortcut(p)                    // → boolean; se traga las excepciones
safeFileName(name)                   // → string; reemplaza caracteres no válidos + colapsa espacios + recorta a 60; si queda vacío, 'Android App'
```

### Implementación interna clave

**`buildDib(bgra, size)` (`shortcut.js:13-33`)**
- `BITMAPINFOHEADER` de 40 bytes escrito a mano: `biSize=40`, `biWidth=size`, `biHeight=size*2` (dos partes XOR + AND), `biPlanes=1`, `biBitCount=32`, `BI_RGB`, `biSizeImage=size*size*4` (`14-21`)
- El mapa de bits XOR invierte el orden de filas **de abajo arriba** (`25-28`; en ICO/DIB el eje y apunta hacia arriba)
- Máscara AND de 1 bpp, filas alineadas a 4 bytes, **todo 0** (`30-31`; el comentario dice «se deja al canal alpha»)

**`pngToIco(pngBuffer)` (`shortcut.js:39-73`): ruta DIB de varios tamaños**
- `require('electron')` dentro de la función (`40`), `nativeImage.createFromBuffer`; si `isEmpty()` devuelve null (`41-42`)
- Para cada uno de los 9 tamaños `resize({quality:'best'})` → `buildDib(img.toBitmap(), s)` (`45-51`)
- En Windows `img.toBitmap()` es **BGRA**, justo el orden que necesita DIB, sin intercambiar canales
- ICONDIR: `reserved=0, type=1, count=n`; cada elemento 16 bytes: `width/height` u8, `colorCount=0`, `reserved=0`, `planes=1`, `bitCount=32`, `bytesInRes`, `imageOffset` (`53-72`)
- **Los bytes de ancho/alto se escriben como 0 cuando `>=256`** (`61-62`): en el directorio ICO un byte 0 significa 256

**`pngBytesToIco(png)` (`shortcut.js:83-101`): ruta PNG-in-ICO**
- Validación: `Buffer` con `length >= 24` y `[1,4)` igual a `'PNG'` (`84`); lee de IHDR en BE `w@16`, `h@20`; `w/h` distintos de cero y `<= 1024` (`85-87`)
- ICONDIR fijo de 22 bytes (6 + 16), `bytesInRes = png.length`, `imageOffset = 22` (`88-99`); la zona de datos **es directamente el PNG original** (sin recodificar ni perder alpha)
- Es válido desde Vista; por eso el comentario dice «la ruta DIB vieja fallaría aquí por completo» (`80-82`)

**`iconToIco(raw, {decode})` (`shortcut.js:109-133`): tres niveles de respaldo**
1. `nativeImage.createFromBuffer(raw)` lo decodifica (PNG/JPEG reales) → `img.toPNG()` → `pngToIco` (`111-118`). **`toPNG()` es necesario**, porque raw puede ser JPEG; a `pngToIco` le sirven PNG/JPEG, pero DIB necesita píxeles
2. Hay callback `decode` → `await decode(raw)` da un PNG → `pngBytesToIco` (`120-126`). WebP va por aquí (lo decodifica Chromium)
3. Provisional: `drawAppIcon(256)` → `pngBytesToIco` (`127-132`)
4. Si todo falla devuelve null

**`writeShortcut(opt)` (`shortcut.js:144-169`)**
- Si la carpeta no existe hace `mkdirSync(recursive)`; si falla lanza «la carpeta de accesos directos no es escribible» (`146-151`)
- **Si el .lnk ya existe primero hace `unlinkSync`** (`152-154`)
- `shell.writeShortcutLink(path,'create',{target,args,icon,iconIndex:0,description,cwd,appUserModelId})` (`155-163`); `icon` usa `target` por defecto
- Si devuelve false lanza «no se pudo crear el acceso directo» (`164`)
- **Verificación leyendo de vuelta**: si `fs.existsSync(shortcutPath)` es falso lanza «el acceso directo no se escribió en disco» (`165-167`); el comentario (`138-141`) registra la trampa: con un programa de seguridad que bloquea o el escritorio redirigido a una nube sin sesión, «devuelve true pero el archivo no existe»

**`safeFileName` (`shortcut.js:75-77`)**
`[\\/:*?"<>|]` → `_`, `\s+` → espacio, trim, `slice(0,60)`, si queda vacío `'Android App'`. **No trata** los nombres reservados de Windows (CON/PRN/NUL…).

### Trampas e invariantes
1. **`pngToIco` no funciona en Node puro**: en Node, `require('electron')` devuelve la **cadena con la ruta** de electron.exe; el `nativeImage` desestructurado queda `undefined` y `createFromBuffer` da TypeError directo (la función no tiene try/catch). Por eso todos los casos de `pngToIco` están en `test/electron-integration.js` (se ejecuta con `electron test/...`), y `npm test` solo prueba `pngBytesToIco`/`iconToIco`.
2. **Las dos ramas del ternario de `shortcut.js:46-48` tienen exactamente el mismo código** (solo cambia el comentario): equivale a un `resize` sin condición. Es «un comentario que explica una rama que no existe» y se puede limpiar. La intención real del comentario es: **ampliar una imagen pequeña es mejor que faltar un tamaño** (interpola un icono de 64 px a 256 px; se ve borroso, pero no queda un hueco de icono).
3. **Invariante de tamaño de `pngBytesToIco`**: el ancho/alto del directorio es de un byte, `>=256` se escribe 0 (=256). Si se pasa un PNG de 512×512, el directorio **dirá 256 y los datos serán de 512**, y algunos shells no lo mostrarán. Hoy lo garantiza el llamador: `decodeIcon` en `main.js:223` limita con `Math.min(256, ...)` y `pngToIco` llega como máximo a 256. **Esta restricción es implícita y es donde más fácil es tropezar al agregar un llamador nuevo.**
4. **La máscara AND del DIB es todo 0**: depende del canal alpha de 32 bpp. Los shells viejos estilo XP tratan el alpha de 32 bpp de forma irregular, pero en Win10/11 no hay problema.
5. **`writeShortcut` borra y luego crea**: se pierden atributos del .lnk original como «anclar a la barra de tareas» o «ejecutar como administrador». `installer.createShortcut` lo recrea en cada reinstalación, así que lo que el usuario ancló a mano puede dejar de funcionar (lo anclado es el AUMID, que normalmente se recupera).
6. **`icon: opt.iconIcoPath || opt.target`**: si falla la generación del ico se usa el icono del exe, así nunca sale un icono de «hoja en blanco».
7. **`appUserModelId` es opcional** (`162`); a partir de `installer.js:299` se pasa «un AUMID por app» para agrupar en la barra de tareas: el comentario está en `installer.js:299` y `writeShortcut` solo lo reenvía.
8. `removeShortcut` se traga todas las excepciones y devuelve false; `installer.uninstall` no comprueba el valor devuelto (`installer.js:373-374`).

### Quién lo llama
- `pngToIco`: `src/main.js:1310` (require), `1311` (lo calcula en el momento si falta el ICO de marca); `shortcut.js:115` (dentro de `iconToIco`); `test/electron-integration.js:23`, `29`, `56`
- `pngBytesToIco`: `shortcut.js:123`, `129`; `test/auto-test.js:495`, `498`, `502`
- `iconToIco`: `src/core/installer.js:13` (require), `212` (al instalar), `346` (al completar iconos); `test/auto-test.js:495`, `505`, `507`
- `writeShortcut`: `installer.js:13`, `292` (`createShortcut`); `test/electron-integration.js:23`, `35`
- `removeShortcut`: `installer.js:13`, `373`, `374` (desinstalación)
- `safeFileName`: `installer.js:13`, `75` (ruta del escritorio), `88` (ruta del menú Inicio), `319` (ruta de respaldo)
- `ICO_SIZES`: solo lo usa `shortcut.js:45`; se exporta sin consumidores externos
- Contexto de llamada: `ctx.decodeIcon` se define en `main.js:213` y se inyecta en `Installer` en `main.js:1498`

### Cobertura de pruebas
- `test/auto-test.js:494` «PNG-in-ICO y el respaldo de iconos WebP producen ICO válidos»: afirma el encabezado ICO `type=1/count=1`, que `bytesInRes` es igual a la longitud del PNG, que `ico.slice(22)` es idéntico al PNG original, que las entradas inválidas devuelven null, que WebP sin decode usa el provisional y que con decode usa la imagen real. **Es el caso mejor cubierto de este archivo.**
- `test/electron-integration.js` (`electron test/electron-integration.js`, **no está en `npm test`**): pasos «Generar ICO», «Crear .lnk», «Borrar .lnk», «Icono del APK → ICO de varios tamaños»; el resultado va a `test/out/result.json`.
- Huecos: no hay aserciones sobre la estructura de bytes DIB de `pngToIco` (solo «se genera y tiene >1000 bytes» en la integración de Electron); `safeFileName` no tiene pruebas de nombres reservados/demasiado largos/caracteres inválidos; la rama «devuelve true pero no se escribió» de `writeShortcut` no se puede construir en una prueba.

---

## 7. `src/core/assoc.js`

### Responsabilidad
Registra/anula la asociación de archivos `.apk` bajo `HKCU\Software\Classes` (sin permisos de administrador): doble clic en el APK → `lanzadorapk.exe "%1"`.

### Interfaz pública
```js
const { registerAssociation, unregisterAssociation, PROGID } = require('./assoc');
PROGID = 'LanzadorAPK.apk'

registerAssociation(exePath /*: string, obligatorio */, iconPath /*?: string */, extraArgs /*?: string */)
  // → { ok: true, progId: 'LanzadorAPK.apk' }   ★ siempre ok:true, aunque fallen todas las escrituras de reg
unregisterAssociation() → { ok: true }        // igual que arriba
```

### Implementación interna clave
- `reg(args)` (`assoc.js:11-18`): `execFileSync('reg', args, {windowsHide:true, stdio:'pipe'})`, **se traga todas las excepciones y devuelve false**, sin propagarlas. → Todas las escrituras en el registro son «de mejor esfuerzo» y el llamador no recibe información de fallos.
- `notifyShell()` (`assoc.js:20-33`): PowerShell `Add-Type` con P/Invoke llama a `SHChangeNotify(0x08000000=SHCNE_ASSOCCHANGED, 0, NULL, NULL)` para que el Explorador actualice iconos/asociaciones; `timeout: 8000`, los fallos se ignoran (comentario en `32`).
- `registerAssociation` (`assoc.js:40-56`) escribe 6 entradas:
  1. Valor por defecto de `HKCU\Software\Classes\.apk` = `LanzadorAPK.apk`
  2. Agrega `LanzadorAPK.apk` a `.apk\OpenWithProgids` (valor vacío `REG_NONE`, `46`; es la forma correcta de aparecer en la lista «Abrir con»)
  3. Valor por defecto de `LanzadorAPK.apk` + `FriendlyTypeName` = «Paquete de app Android»
  4. `DefaultIcon` = `"<icon>",0`
  5. Valor por defecto de `shell\open` = «Instalar en LanzadorAPK»
  6. `shell\open\command` = `"<exePath>" <extraArgs> "%1"` (`43`)
- Armado de `command` (`assoc.js:43`): **el llamador se encarga de poner comillas en** `extraArgs` (en modo desarrollo hay que pasar la carpeta de la app). Puntos de llamada reales: `main.js:1315` pasa `l.args` (`launcherInfo()` ya trae comillas) y `scripts/assoc.js:22` pasa `"<appDir>"`.
- `unregisterAssociation` (`assoc.js:58-66`): borra el valor de `OpenWithProgids` → borra todo el subárbol `LanzadorAPK.apk` → vacía **sin condiciones** el valor por defecto de `.apk` → avisa al shell.

### Trampas e invariantes
1. **★★ El comentario no coincide con la implementación (defecto real)**: `assoc.js:62` dice «solo se borra el valor por defecto si .apk sigue apuntando a nosotros», pero `assoc.js:63` es `reg(['add', ...EXT, '/ve', '/d', '', '/f'])` **sin ninguna condición**. Consecuencia: si el usuario tenía `.apk` asociado a otra herramienta (o el «tipo desconocido» por defecto del sistema), al quitar la asociación el valor queda vacío y la asociación original se pierde, sin copia ni restauración. Solución: leer primero el valor actual con `reg query` y solo borrarlo si es igual a `PROGID`.
2. **El valor devuelto no informa nada**: `registerAssociation` siempre devuelve `ok:true`, así que el IPC de `main.js:1315` no distingue «éxito» de «todo bloqueado por una directiva». Un aviso de éxito en la interfaz sería falso.
3. **`notifyShell` depende de PowerShell + `Add-Type`**: en equipos sin PowerShell/con directivas restringidas falla en silencio y la asociación no se actualiza (el usuario tiene que volver a iniciar sesión o actualizar a mano). `timeout: 8000` bloquea de forma síncrona el proceso principal, en el peor caso 8 s.
4. **Las comillas de `extraArgs` son responsabilidad del llamador** (`assoc.js:43`); una ruta con espacios sin comillas arma una línea de comandos errónea.
5. Solo escribe en HKCU, nunca en HKLM: es la clave de «no necesita administrador», y también significa que **con varios usuarios cada uno debe registrarlo por su cuenta**.
6. `PROGID` está fijo en `'LanzadorAPK.apk'` y junto con `EXT='.apk'` forma el contrato del registro; si se renombra, los restos registrados por versiones viejas no los podrá limpiar `unregisterAssociation` (solo borra el árbol de `PROGID`).

### Quién lo llama
- `registerAssociation`: `src/main.js:30` (require), `main.js:1315` (IPC `assoc:register`); `scripts/assoc.js:10`, `21`
- `unregisterAssociation`: `main.js:1318` (IPC `assoc:unregister`), `main.js:1351` (`try/catch` dentro del flujo de desinstalación); `scripts/assoc.js:26`
- `PROGID`: `main.js:1297` (`assoc:status` decide que está asociado si aparece en la salida de `reg query`)
- Interfaz: `src/ui/app.js:754-755` solo usa el campo `registered` de `assoc:status`

### Cobertura de pruebas
**Ninguna.** `grep -r assoc test/` no encuentra nada; ni `auto-test.js` / `engine-test.js` / `run-tests.js` tienen casos del registro (porque cambiarían el estado). `scripts/assoc.js` es un interruptor manual. Es el único módulo del grupo «sin ninguna verificación automática».

---

## 8. `src/core/version.js`

### Responsabilidad
Comparación de números de versión. Va en un módulo pequeño aparte **para evitar la dependencia circular `updater` ↔ `sources`** (comentario de `version.js:3`).

### Interfaz pública
```js
const { parseVer, cmpVer } = require('./version');

parseVer(v)     // → Array<number|string>: quita el prefijo 'v', corta por [.+-], los segmentos numéricos pasan a Number, filtra los vacíos
cmpVer(a, b)    // → 1 (a>b) | -1 (a<b) | 0 (iguales)
```

### Implementación interna clave
- `parseVer` (`version.js:7-13`): `String(v||'')` → `replace(/^v/i,'')` → `split(/[.+-]/)` → los segmentos numéricos a `Number`, los no numéricos quedan como cadena → `.filter(x => x !== '')`.
  - `'v0.3.2'` → `[0,3,2]`; `'0.3.2-preview'` → `[0,3,2,'preview']`; `'1.0.0+build'` → `[1,0,0,'build']`.
- `cmpVer` (`version.js:16-34`): compara segmento a segmento hasta la longitud del más largo; **si uno se acaba antes → el corto es menor** (`23-24`); si ambos son number se comparan como números, si no por orden lexicográfico con `String()` (`25-31`).

### Trampas e invariantes
1. **`cmpVer('1.0','1.0.0') === -1`, no 0** (semántica de `23-24`). Usado en `updater.hasUpdate` (`updater.js:109`), «actual 1.0 / remota 1.0.0» se consideraría una actualización; hoy las versiones siempre tienen tres partes y no ocurre, pero **no lo uses para comprobar «igualdad»**.
2. **No es semver**: los segmentos de prerrelease se comparan como texto → `'preview' > 'beta'` (lexicográfico), `'rc1' > 'rc'`; `1.0.0+build` resulta **mayor** que `1.0.0` por tener un segmento más (en semver la metadata de build se ignora). Para «ordenar tags de releases de GitHub/Gitee» basta.
3. Los segmentos numéricos usan `Number()`, así que `'01'` y `'1'` son iguales; `'1.10' > '1.9'` es correcto (comparación numérica).
4. Cadena vacía / `null` → `[]`, que comparado con cualquier versión no vacía da `-1`.
5. El módulo no tiene dependencias a propósito (solo exporta dos funciones puras); si cualquiera de los dos lados agrega dependencias, vuelve el ciclo.

### Quién lo llama
- `cmpVer`:
  - `src/core/provision.js:17` (require), `513` (`cands.sort((a,b) => cmpVer(b.tag, a.tag))`, elige la versión de la imagen)
  - `src/core/sources.js:20` (require), `299` (lista de releases ordenada por tag de mayor a menor)
  - `src/core/updater.js:22` (require), `109` (`hasUpdate: cmpVer(merged.tag, this.current) > 0`), `333` (**reexporta** `cmpVer`, así los consumidores de `updater.js` pueden saltarse version.js)
- `parseVer`: solo `version.js:17-18` (dentro de `cmpVer`)
- Pruebas: `test/auto-test.js:821` lo importa desde `../src/core/updater` (por la reexportación), no directamente de `version.js`

### Cobertura de pruebas
- `test/auto-test.js:820` «la comparación de versiones es numérica por partes; el prefijo v y varias partes funcionan»: 4 aserciones: `v0.3.2 > 0.3.1`, igualdad con prefijo `v`, `0.10.0 > 0.9.9` (contra la comparación de texto), `1.0.0 < 1.0.1`.
- Huecos: no hay casos de `1.0` vs `1.0.0`, segmentos de prerrelease, `+build` ni valores vacíos.

---

## 9. `src/core/logfile.js`

### Responsabilidad
Escritura de registros ligera + rotación por tamaño (solo conserva una copia `.1.log`), para que `app.log` / `emulator.log` no crezcan sin límite y llenen el disco.

### Interfaz pública
```js
const { append, rotate, trimNow } = require('./logfile');

append(file, line, limitKB = 2048)   // → boolean (true=escrito; cualquier excepción false; el registro nunca lanza)
rotate(file, limitKB)                // → boolean (true=esta vez se rotó)
trimNow(file, limitKB = 2048)        // → boolean (= rotate, pero sin contador; ★ sin llamadores en src)
```

### Implementación interna clave
- Comentario de motivación (`logfile.js:4-9`): emulator escribe decenas de KB de registro del núcleo en cada arranque; una docena de arranques al día + qemu verbose → cientos de MB en unos meses.
- `counters = new Map()` (`13`): cuenta por ruta de archivo **dentro del proceso**; no se comparte entre procesos.
- `rotate(file, limitKB)` (`15-26`):
  - Si `statSync` falla (el archivo no existe) → catch devuelve false (`23-25`)
  - `size < limitKB*1024` → false (`18`), es decir, **solo rota si supera el límite**
  - Nombre de la copia: `file.replace(/\.log$/i, '.1.log')` (`19`); primero `rmSync(bak,{force:true})` y luego `renameSync(file,bak)` → siempre queda una sola copia
- `append(file, line, limitKB)` (`33-45`):
  - `mkdirSync(dirname, {recursive:true})` (`35`; asegura la carpeta incluso al escribir registros)
  - Contador +1; **solo hace `rotate` con `n===1` (primera vez en el proceso) o `n%200===0`** (`39`; comentario de `38`: `statSync` es barato pero no hace falta en cada línea)
  - `appendFileSync(file, line.endsWith('\n') ? line : line+'\n')` (`40`, agrega el salto de línea solo)
  - Límite inferior: `Math.max(256, Number(limitKB) || 2048)` (`39` / `49`): el tope mínimo es 256 KB
  - Toda la función va en try/catch y devuelve false si falla (`41-44`)

### Trampas e invariantes
1. **★ Si el nombre de archivo no termina en `.log` se pierde el registro**: `bak === file`, así que `rmSync(bak)` borra el archivo y `renameSync` falla porque el origen no existe (ENOENT) → devuelve false con **el registro original ya borrado**. Hoy las dos llamadas pasan `*.log` (`app.log`, `emulator.log`) y no estalla; cualquier llamada nueva debe respetar el contrato implícito de «nombre terminado en .log».
2. **La rotación ocurre antes del append** (`39` antes de `40`): tras rotar se escribe de inmediato en el archivo nuevo; el registro es continuo y no se pierde «la línea de justo después de rotar».
3. **El contador es por proceso**: al reiniciar el proceso principal vuelve a contar desde 1 → cada inicio hace al menos un `statSync`, que es correcto (y también significa que **sin reiniciar en mucho tiempo** pueden escaparse hasta 199 líneas sin comprobar).
4. **Varios escritores sin bloqueo**: si el proceso principal y (en el futuro) un proceso hijo escriben el mismo archivo, `rotate` tiene una condición de carrera (A borra bak, B también, A renombra bien, B falla → el registro de B va al archivo nuevo; en realidad es aceptable).
5. **`limitKB` es un «umbral de rotación», no un «límite duro»**: una sola `line` de append puede ser tan larga como sea (emulator escribe de una vez decenas de KB de salida de arranque), y tras rotar el archivo puede seguir muy por encima del umbral hasta la siguiente comprobación.
6. **`trimNow` es código muerto** (`48-50`, cero llamadas en todo el proyecto): era para «limpiar al iniciar», pero la rama `n===1` de `append` ya lo cubre.
7. El `limitKB` que pasan los llamadores no es uniforme: `main.js:84` usa `settings.engine.logLimitKB`; `emulator.js:576` usa `logLimitKB * 4` (y además `Math.max(2048, ...)`): la misma opción se multiplica por 4 en un lugar; tenlo en cuenta al leer el número de la configuración.

### Quién lo llama
- `append`:
  - `src/main.js:85` (`appLog()`, `limit = store.getSettings().engine.logLimitKB || 2048`, ver `main.js:84`)
  - `src/core/emulator.js:577` (`_logWrite()`, `limit = max(2048, logLimitKB*4)`, ver `emulator.js:576`)
  - Ojo: en los dos casos el **`require('./logfile')` está dentro de la función** (carga diferida), no al principio del módulo
- `rotate`: `logfile.js:39` (el propio), `test/auto-test.js:1408`
- `trimNow`: ninguno
- Pruebas: `test/auto-test.js:1405`

### Cobertura de pruebas
- `test/auto-test.js:1404` «si el registro supera el límite se rota solo y se conserva una sola copia»: escribe 300 KB, `rotate(f,256)` y afirma que el archivo pasa a `rot.1.log`.
- Huecos: no hay casos de la ruta de conteo/rotación automática de `append` (`n===1`, `n%200`), ni de `trimNow`, ni de la pérdida de datos con nombres que no son `.log`.

---

## 10. Anexo: `src/core/display.js` (también del grupo de utilidades puras)

Aunque no pertenece a la cadena de análisis, es otro módulo pequeño de `src/core` de «cálculo puro sin dependencias y con pruebas unitarias»; conviene conocerlo al tomar el proyecto.

- **Responsabilidad**: cálculos puros de adaptación de pantalla (sin depender de Electron/adb): rectángulos de ventana para pantalla completa/ventana y resolución de Android (`display.js:2-6`).
- **Interfaz**: `densityFor(w,h,manual)` → number (con manual>0 limita a 120..640; si no, `min(w,h)/2.57` limitado a 200..480, `7-10`); `portraitSize(str)` → `{w,h}` (regex `^(\d{3,4})x(\d{3,4})$`; si no es vertical o se sale de rango vuelve a `900x1600`, `12-18`); `defaultBounds(area)` → `{x,y,w,h}` (alto 84 %, ancho = alto·9/16, centrado, `20-28`); `fullscreenBounds(portrait,area)` (ocupa toda la altura, ancho según la proporción vertical, centrado horizontal, `36-46`); `sizeFor(mode,portrait,area)` (`55-57`).
- **Trampa clave**: `sizeFor` **ignora por completo el parámetro `mode`** (`55-57`, siempre devuelve el preajuste vertical). No es un error: el comentario (`48-54`) explica que la proporción de la ventana del emulador queda fijada por el LCD al arrancar y cambiar la resolución de Android deformaría la imagen; «pantalla completa» solo maximiza la ventana.
- **Quién lo llama**: `src/main.js:32` (require), `main.js:276` (`display.portraitSize(d.portrait || '540x960')`); pruebas `test/auto-test.js:465`.
- **Pruebas**: `auto-test.js:465` «adaptación de pantalla: ventana y pantalla completa comparten la resolución vertical; la ventana 9:16 se puede estirar», cubre `sizeFor`/`defaultBounds`/`fullscreenBounds`/`densityFor`.

---

# 11. Panorama de la pila de análisis sin conexión

## 11.1 Entradas y cadenas de llamadas

**Cuatro entradas**
| Entrada | Cadena |
|---|---|
| Análisis de vista previa en la interfaz | `ui/app.js` → `preload.js:10` `parseApk` → `main.js:756` `apk:parse` → `parseApk` |
| Instalación desde la interfaz (la ruta principal real) | `ui/app.js:484` `api.installApk` → `main.js:758` `apk:install` → `installer.install` (`installer.js:141`) → `parseApk` (`149`) o `parseBundle` (`146`) |
| Doble clic en .apk (asociación de archivos) | `command` escrito por `assoc.js` → `lanzadorapk.exe "%1"` → `parseArgs` de `main.js:206` reconoce `.apk` → flujo de instalación |
| Autocomprobación por línea de comandos | `scripts/selftest.js:142` → `parseApk` |

**Cadena de llamadas en texto a partir de `parseApk(filePath)`**

```
parseApk(filePath)                                   apk.js:75
├─ fs.statSync(filePath)                            apk.js:76   → sizeBytes
├─ fs.readFileSync(filePath)                        apk.js:78   ← [el paquete entero en memoria]
├─ new ZipArchive(buf)                              apk.js:79   → zip.js:13
│  ├─ _parse()                                      zip.js:20
│  │  ├─ búsqueda del EOCD desde el final (ventana de 65557 B)               zip.js:23-26
│  │  ├─ total@+10 / cdOffset@+16                   zip.js:29-30
│  │  └─ bucle del directorio central → entries(Map)                zip.js:32-47
│  ├─ has('AndroidManifest.xml')                    apk.js:81   (si no → lanza «puede ser .apks/.xapk»)
│  ├─ read('AndroidManifest.xml')                   apk.js:85   → zip.js:54 (inflateRawSync)
│  └─ (solo lee imágenes para el icono de respaldo)                    apk.js:43
├─ parseAxml(manifestBuf)                           apk.js:86   → axml.js:67
│  ├─ readStringPool (dos ramas UTF-8/UTF-16)         axml.js:88  → 26
│  ├─ START_ELEMENT + attr×N (20 B cada uno, base +16)    axml.js:98-140
│  └─ devuelve el nodo manifest                            axml.js:147
├─ attrValue(manifest,'package', ns=null)           apk.js:88
├─ new ResTable(zip.read('resources.arsc'))         apk.js:104  → arsc.js:79 (try/catch; si falla → null)
│  ├─ pool de cadenas global (solo el primero)                    arsc.js:99-100
│  ├─ packages[].types: Map<typeId, config[]>       arsc.js:101-103 / 141
│  └─ resolve(ref, 'string'|'file')                 arsc.js:200 → score() elige la config
│     ├─ label:  resolve(labelRef,'string')        apk.js:111
│     ├─ icon:   resolve(iconRef,'file')           apk.js:141
│     └─ adaptativo: iconFromAdaptiveXml → parseAxml → resolve → zip.read   apk.js:51-73
├─ isLauncherActivity(activity|activity-alias)      apk.js:122 → 15
├─ !icon → pickIconFromZip(zip)                     apk.js:152 → 27 (puntuación por nombre+uncompSize)
├─ abis = lib/<abi>/ de zip.names() sin duplicados           apk.js:155
└─ return { package,label,versionName,versionCode,minSdk,targetSdk,
            launchActivity,abis,iconPng,iconFile }  apk.js:160-174

──────────────────── lado installer (metadatos → icono → ICO → .lnk) ────────────────────

installer.finishInstall(rt, meta, ...)               installer.js:179
├─ store.iconPath(pkg) → escribe <ICON_DIR>/<pkg>.png    installer.js:208-209 (¡el contenido puede ser WebP!)
├─ iconToIco(meta.iconPng, {decode: ctx.decodeIcon}) installer.js:212 → shortcut.js:109
│  ├─ ① nativeImage.createFromBuffer → pngToIco     shortcut.js:112-116 → 39
│  │     └─ resize ×9(16..256) → buildDib → ICONDIR  shortcut.js:13 / 45-72
│  ├─ ② decodeIcon(raw) (BrowserWindow oculta+canvas) main.js:213-229
│  │     └─ canvas.toDataURL('image/png') → pngBytesToIco  shortcut.js:83
│  └─ ③ drawAppIcon(256) → pngBytesToIco            shortcut.js:127-129 → png.js:80
├─ escribe <ICON_DIR>/<pkg>.ico                           installer.js:214-215
├─ store.upsertApp(app)                              installer.js:259
└─ createShortcut(app)                               installer.js:265 / 286
   ├─ safeFileName(label) → dos rutas, escritorio / menú Inicio   installer.js:75 / 88
   └─ writeShortcut({target,args,iconIcoPath,...})   installer.js:292 → shortcut.js:144
      └─ shell.writeShortcutLink + verificación con fs.existsSync shortcut.js:155-167
```

## 11.2 Perfil de memoria y tiempo

| Fase | Forma de los datos | Coste máximo |
|---|---|---|
| `readFileSync` (`apk.js:78`) | Buffer con todo el APK | ≈ tamaño del archivo (APK de 500 MB → 500 MB) |
| `ZipArchive._parse` | `Map` de metadatos del directorio central | ~100 B por entrada; 10.000 entradas ≈ 1 MB |
| `zip.read(manifest)` | resultado del inflate | El manifiesto suele ocupar decenas de KB |
| `zip.read(resources.arsc)` | resultado del inflate | Varios MB (las apps de grandes empresas pueden pasar de 10 MB) |
| `ResTable._parse` | árbol de Map de `packages[].types` | Proporcional al número de recursos; en apps de cientos de MB, de varios MB a más de diez MB |
| `zip.read(icon)` | bytes originales del icono | Normalmente < 1 MB (un webp xxxhdpi ocupa decenas de KB) |
| Todo el proceso | el Buffer viejo no se libera (lo retiene `zip.buf`) | **el APK completo queda residente hasta terminar el análisis** |

Tiempo: un APK normal (de ~50 MB) ≈ 100–300 ms, sobre todo en `inflateRawSync(resources.arsc)` y el recorrido de entries de `ResTable`; `drawAppIcon(256)` del orden de 10 ms (y `main.js:175` lo calcula una sola vez al iniciar y lo guarda).

## 11.3 Lo más frágil y que más vale la pena refactorizar (por «beneficio/riesgo»)

1. **`parseApk` lee el paquete entero en memoria (`apk.js:78`): lo primero que hay que cambiar**
   El `ZipFile` existente ya puede leer solo el directorio central + las entradas en flujo bajo demanda; `provision.js:594-595` es el precedente de «>64 MB usa ZipFile». Si `parseApk` pasa a `new ZipFile(filePath)` y solo lee `AndroidManifest.xml` / `resources.arsc` / el icono, la memoria máxima baja de «el tamaño del archivo» a «unos pocos MB», y de paso se evita el límite de 2 GB por Buffer. El cambio se limita a `apk.js:75-175` + un `finally close()`, y en `installer.parseBundle` se copia igual (hoy `installer.js:27` también hace `readFileSync` del paquete entero).
   Ojo: `zip.read` tiene semántica de valor vacío distinta en las dos clases (`ZipArchive` devuelve null / `ZipFile` lanza error); al sustituir hay que agregar la comprobación `has()`.

2. **No hay Zip64 (`zip.js:29-30`, `37`, `161-162`, `180`)**
   Con más de 65535 entradas, una entrada de más de 4 GiB, o `cdOffset === 0xffffffff` en el EOCD:
   - `ZipArchive`: `zip.js:30` obtiene `offset = 0xffffffff` y luego el `readUInt32LE(offset)` de `zip.js:33` da directamente `RangeError`, que sale del constructor (el mensaje no tiene nada que ver con «no es un ZIP válido» y cuesta encontrarlo);
   - `ZipFile`: `cdOffset > eocdAbs` cae en `zip.js:166-169`, `len` queda negativo → lanza «desplazamiento anómalo del directorio central del ZIP»; con `total === 0xffff` solo analiza las primeras 65535 entradas y las demás **se pierden en silencio**.
   Los APK rara vez superan 4 GB, pero las **imágenes del sistema/paquetes de actualización** (`provision.js` / `updater.js` usan el mismo código) acabarán chocando. Solución: si el EOCD tiene `0xffff/0xffffffff`, ubicar el EOCD Zip64 (`0x06064b50`) y el locator Zip64 (`0x07064b50`), y pasar `compSize/uncompSize/localOffset/cdOffset/total` a u64 (con `readBigUInt64LE` y luego Number; ojo con la precisión de 2^53).

3. **La decodificación WebP depende de una ventana oculta de Electron (`main.js:213-229` + `shortcut.js:120-126`)**
   Muchísimos iconos de APK son WebP y `nativeImage` no los decodifica; solo queda abrir una `BrowserWindow` + `canvas` + base64 (`raw.toString('base64')` multiplica por 1,33 la memoria al instante, más la cadena data URL). Tres problemas:
   - Sin GUI / headless / sin Electron (el `selftest` de Node puro, las pruebas) **se degrada en silencio al icono provisional de marca**: el usuario ve el triángulo verde y no el icono real;
   - Los errores de `executeJavaScript` no se distinguen: un fallo al decodificar WebP y un fallo al crear la ventana dan el mismo «sin icono»;
   - Cada llamada hace un viaje de ida y vuelta tipo IPC; al instalar en lote es un cuello de botella en serie evidente.
   Sugerencia: incluir un decodificador WebP mínimo (o al menos distinguir en `iconToIco` entre «provisional» y «fallo real de decodificación», y pasar el motivo a los warnings de `installer`, para que la interfaz pueda avisar «no se pudo leer el icono»).

4. **La lista permitida de formatos al extraer iconos es demasiado estrecha (`apk.js:29`, `apk.js:67`)**
   Solo admite `.png`/`.webp`. Resultado: los iconos `.jpg`/`.jpeg`, las combinaciones `<inset>`/`<layer-list>`/`<bitmap>` dentro de `<adaptive-icon>` y los recursos shape de `drawable` caen todos en el respaldo heurístico de `pickIconFromZip`, que puede sacar la pantalla de inicio/imagen de fondo (la puntuación solo mira `uncompSize` y el nombre). Sugerencia: agregar `jpe?g` a las candidatas; recorrer un nivel del XML y tomar el primer `<bitmap android:src>`; puntuar con el tamaño real en píxeles leído del encabezado PNG/WebP (`png.js` no tiene decodificador, pero leer el encabezado IHDR/VP8 son una docena de líneas).

5. **La elección de config de `arsc.js` es heurística (`arsc.js:65-77`)**
   `anydpi` resta 500, `language` resta 40 y `sdkVersion/1000` son constantes inventadas; no hay coincidencia de locale (una app en chino puede obtener el nombre en inglés) ni coincidencia exacta «por densidad de pantalla». Y las tres codificaciones de entry (sparse / offset16 / u32) **no tienen ninguna prueba**: si una versión de las herramientas de Android cambia la codificación, el síntoma es «todos los iconos y nombres pasan de golpe a los valores por defecto», sin error (el try/catch de `apk.js:103-105` lo convierte en `res=null`).
   Sugerencia: agregar casos de bytes sintéticos para `ResTable` y sacar las constantes de `score()` a una configuración explícita.

6. **La base relativa de `attributeStart` no tiene ninguna defensa (`axml.js:105-106`)**
   Es la línea de toda la cadena más fácil de romper con un «refactor de paso», y al romperla **no da error, solo desplaza**. Sugerencia: agregar un caso AXML mínimo escrito a mano de unas 20 líneas de bytes (pool de cadenas + un start element + dos atributos) que afirme que `attr()` obtiene `package` y `android:label`.

7. **`assoc.unregisterAssociation` vacía sin condiciones el valor por defecto de `.apk` (`assoc.js:62-63`)**
   La protección que promete el comentario no existe y borra la asociación `.apk` que tenía el usuario; además todo el módulo no tiene pruebas. La solución está en la trampa 1 de la sección 7.

8. **`logfile.rotate` borra antes de renombrar con nombres que no son `*.log` (`logfile.js:19-21`)**
   Un solo caso límite `bak === file` basta para perder el registro; sugerencia: agregar una guardia explícita `if (bak === file) return false;`.

9. **El código del pool de cadenas está duplicado (`axml.js:26` / `arsc.js:23`)**
   La lógica es idéntica (incluido el punto delicado de las dos longitudes varint de UTF-8). Sugerencia: llevarla a `src/core/respool.js`, así un arreglo vale para los dos.

10. **Código muerto/exportaciones inútiles dispersos** (limpiarlos cuesta poco, pero confunden a quien llega nuevo)
    `quickCheck` (`apk.js:178`, solo para pruebas), `trimNow` (`logfile.js:48`, cero llamadas), la exportación `TYPE_REFERENCE` (`arsc.js:233`), la exportación `ICO_SIZES` (`shortcut.js:182`), el import sin usar `ANDROID_NS` (`apk.js:9`), el noop de `apk.js:38`, el ternario con dos ramas iguales de `shortcut.js:46-48`, el `pkgCount` leído y sin usar de `arsc.js:92`, y el IPC `apk:parse` sin consumidor en la interfaz (`main.js:756` + `preload.js:10`).

## 11.4 Lista de huecos de pruebas (por riesgo)

`npm test` ejecuta en realidad `node test/run-tests.js && node test/engine-test.js && node test/auto-test.js` (`package.json:37`); **`test/electron-integration.js` no está incluido** (hay que ejecutar a mano `electron test/electron-integration.js`).

| Hueco | Impacto |
|---|---|
| AXML / ARSC sin casos de bytes sintéticos; sin APK real de prueba se omite todo (`run-tests.js:130-132`) | En CI `axml.js`/`arsc.js`/`apk.js` tienen cobertura cero |
| `arsc.resolve()` no tiene ninguna aserción | Las tres codificaciones de entry + la puntuación de config quedan sin red |
| `.apks` / `.xapk` (`installer.parseBundle`) sin casos | La ruta de paquetes divididos depende por completo de la verificación manual |
| `assoc.js` sin cobertura | Nadie se entera si se escribe/borra mal en el registro |
| `pngToIco` / `writeShortcut` solo «funcionan» en la integración de Electron, fuera de `npm test` | Que `npm test` pase no significa que el ICO/.lnk funcionen |
| La ruta de rotación automática de `logfile.append` no está probada | Solo se prueba llamando directamente a `rotate` |
| Límites de `safeFileName` / `cmpVer` sin probar | Nombres de archivo inválidos, `1.0` vs `1.0.0` |
| No hay casos negativos de Zip64 / entradas enormes / directorio central truncado | Los problemas con archivos grandes solo se reproducen en producción |

---

*Este documento está en curso: los números de línea se basan en la instantánea 0.3.4; actualízalos al cambiar los archivos relacionados.*
