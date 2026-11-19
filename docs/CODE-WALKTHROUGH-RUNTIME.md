# Recorrido por el código de la pila del runtime (sources / download / provision / updater / store / layers / utilidades)

> Versión del código: `package.json` = **0.3.5**, `main` = `src/main.js`. (Documento histórico del proyecto original: Gitee y los espejos ya se eliminaron en Lanzador APK; hoy solo se usa GitHub con verificación SHA-256).
> Los números de línea corresponden a la copia de trabajo de entonces (`D:\lanzadorapk-dsh\lanzadorapk`); los archivos pueden haber cambiado: guíate por el nombre de la función y vuelve a comprobar la línea antes de citarla.
> Alcance de la lectura: `src/core/{sources,download,provision,updater,store,layers,logfile,notify,android,display}.js`,
> y de paso los llamadores `src/main.js` / `src/core/{engine,emulator,installer}.js` y `test/`.
> Este documento solo describe hechos del código; «✓» = tiene pruebas, «✗» = sin cobertura.

Dirección de dependencias (importante, para evitar require circulares):

```
main.js ──> engine.js ──> provision.js ──> sources.js ──> version.js
   │            │              │  │
   │            │              │  └──> download.js
   │            │              └─────> store.js / doctor.js / zip.js
   │            ├──> emulator.js ──> provision.js / logfile.js
   │            └──> layers.js ──> store.js (require diferido dentro de summary)
   ├──> updater.js ──> sources.js / download.js / zip.js / version.js
   ├──> installer.js ──> store.js / provision.js (a través de runtime.provisioner)
   └──> android.js / notify.js / display.js / logfile.js
```

El motivo de que `version.js` exista aparte está en `version.js:2-4`: evitar que `updater ↔ sources` se hagan require mutuamente y formen un ciclo.

---

## 1. `src/core/sources.js` — dos fuentes GitHub / Gitee + espejos + medición de velocidad + caché con cortacircuitos

### Responsabilidad
Abstrae «leer la información de versiones» y «obtener direcciones de descarga» en un conjunto de URL candidatas ordenadas por **velocidad real medida en bytes**, y corta por un tiempo las fuentes limitadas o con error.

### Interfaz pública

| Exportación | Firma | Descripción |
|---|---|---|
| `Sources` | `new Sources(settingsFn)` | `settingsFn: () => settings`, se lee en cada decisión (no guarda la configuración en caché) |
| `Sources#blockedReason` | `(id: 'github'\|'gitee') => string\|null` | `null` = disponible; si no, devuelve el motivo `omitida temporalmente (no se reintenta en N minutos)` (230-234) |
| `Sources#fetchReleases` | `() => Promise<Array<{source,name,web,rel?,error?}>>` | Según `sourcePreference` consulta una o las dos, en paralelo con `Promise.all` (237-271); las pruebas pueden sustituirla |
| `Sources#latest` | `({force=false}) => Promise<Merged>` | Información de versión combinada (ver abajo), caché de 10 minutos (277-364) |
| `Sources#candidates` | `(assetOrUrl: string\|{url}\|{urls:[]}) => string[]` | Primero el origen, luego los espejos, sin duplicados y manteniendo el orden (371-393) |
| `Sources#rank` | `(urls, {onProgress}) => Promise<string[]>` | Orden descendente por la velocidad medida en caché de 30 minutos; con ≤1 dirección devuelve directamente (399-432) |
| `Sources#reset` | `() => void` | Vacía la caché de velocidad + la de versiones + el cortacircuitos (435-439) |
| `SOURCES` | `{github:{id,name,api,web}, gitee:{...}}` | Constante; el owner está fijo en 22-24 |
| `measure` | `(url, {bytes=256*1024, timeoutMs=9000}) => Promise<{url,ok,got,ms,ttfb,speed,error?}>` | Descarga de verdad 256 KB para medir el rendimiento (108-157) |
| `withMirror` | `(url, prefix) => string` | Agrega la barra final al prefijo; si no es `http(s)://` devuelve `''` (160-164) |
| `mirrorList` | `(settings) => string[]` | Si hay prefijo propio solo vale ese → si no, los espejos incluidos cuando `autoMirror!==false` (207-213) |
| `KNOWN_MIRRORS` | `['https://ghfast.top/','https://gh-proxy.com/']` | 42-45 |

Estructura que devuelve `latest()` (350-361):

```js
{
  version, tag, name, notes, htmlUrl, publishedAt,
  assets: [{ name, size, url, urls: string[], sizes: { [url]: bytes },
             parts?: [{index,size,urls:[]}], partial?: bool, source }],
  sources: [{ source, name, tag }],      // fuentes que participan en la combinación
  unreachable: [{ source, name, error }],
  bySource,                              // fuente ganadora
  stale?: true, staleReason?             // todas las fuentes caídas pero hay un resultado viejo (296)
}
```

### Implementación clave

**1) Obtener versiones = consultar las dos en paralelo + interfaz de lista como respaldo (248-269)**
- Primero `${api}/releases/latest`; si falla, `${api}/releases?per_page=10` y se toma el primero que no sea `draft`;
- Los repositorios privados de Gitee devuelven **404 "Not Found Project"** (no 401); entonces se puede poner un `runtime.giteeToken` de solo lectura (243-246 agrega `access_token`);
- Solo `403/429` activan el cortacircuitos, `_blockMs = 15min` (226, 263). **El cortacircuitos también se anota en `latest()`** (286-290); el comentario explica que es para que las pruebas puedan sustituir «quién da el resultado» (así lo inyecta auto-test).

**2) Estrategia de combinación**
- La versión más alta se elige con `cmpVer` (299), y luego **solo se conservan los recursos de esa misma versión** (307-310);
- Lista permitida de recursos: `/^LanzadorAPK/i` (316), que excluye los paquetes de código fuente que agrega Gitee;
- Los recursos con el mismo nombre en varias fuentes se unen en `urls[]` y **se guarda `sizes{}` por dirección** (334-348): las dos fuentes comprimen con distinto número de bytes y nunca se puede promediar;
- Si la misma versión tiene paquete entero y partes, **se prefiere el entero** (326-327);
- Si todas las fuentes fallan pero existe `_relCache.value` → se devuelve el resultado viejo marcado `stale` (292-298), para que la interfaz no dé error directamente.

**3) Tres niveles de caché**

| Caché | Campo | TTL | Invalidación |
|---|---|---|---|
| Velocidad | `_rankCache: Map<url,{at,ok,speed}>` | 30 min (219) | `reset()`; `ok=false` también se guarda y al ordenar cuenta como -1 (418-421) |
| Versiones | `_relCache: {at,key,value}` | 10 min (223) | `key` no coincide (cambió `sourcePreference`) / `force` / `reset()` |
| Cortacircuitos | `_blocked: Map<sourceId, untilMs>` | 15 min (226) | `reset()` |

**4) La medición es «en serie» (408-417)**: el comentario dice claramente que en paralelo se quitarían ancho de banda unas a otras y se mediría «quién compite más fuerte». El coste es, en el peor caso, `candidatas × 9 s` (el `timeoutMs` de `measure`).

**5) El rendimiento solo cuenta el tiempo «desde el primer byte» (120-122)**: `span = now - (firstAt || t0)`, que excluye el coste fijo de TLS/DNS; si no, una fuente «con mucha latencia pero mucho ancho de banda» se tomaría por lenta.

**6) Reconstrucción de partes `groupParts` (172-204)**: `xxx.zip.part1/.part2` → recurso lógico `{name, size=Σ, parts:[{index,size,urls:[]}], partial:true}`; si faltan direcciones o los números no son consecutivos → `broken`, lo filtra `list`; la lista `broken` se devuelve pero `latest()` **no la expone**.

### Trampas e invariantes

- **Gitee permite 100 MiB por archivo** (comentario en 172-204, `.github/release.yml:36-44,78-100`): si se supera se divide en `.part1/.part2`; `updater._downloadParts` las vuelve a unir.
- **Las entradas de recursos de Gitee no tienen `size`** (198-201): por eso la «integridad» solo exige «partes consecutivas + cada parte con dirección», no `size>0`; con tamaño desconocido el progreso se muestra por bytes recibidos.
- **Los paquetes de código fuente `v1.2.3.zip` / `.tar.gz` se cuelan entre los recursos** (313-316): los frena la lista permitida `^LanzadorAPK`; con un sufijo como `\.zip$` se bajaría el código fuente como actualización.
- **Los espejos solo sirven para direcciones de GitHub** (366-369, 385-390): ghfast / gh-proxy solo hacen de proxy para GitHub; con Gitee solo dan 403 y se pierde una medición.
- **Los recursos con el mismo nombre deben conservar todas las direcciones** (329-333): antes se quitaban duplicados por nombre «el primero gana»; GitHub iba primero → se perdía la dirección de Gitee → la elección automática de fuente se reducía a GitHub.
- `SAMPLE_BYTES = 256KB` (52), pero el comentario de `provision.installRuntimePack:532` aún dice «128KB»: **el comentario está desactualizado; la implementación usa 256 KB**.
- En `measure`, `openUrl` devuelve `res` (el flujo), y en `done()` `req.destroy()` cierra el flujo, no el objeto de petición (`req = res` en 115-132); funciona, pero el nombre confunde.
- `groupParts` también marca `broken` a `part0` (empezando en 0) (196 exige `index === i+1`).
- Invariante: el primer elemento de `candidates()` es siempre **la URL del origen original** (380-382), y `rank()` solo ordena si `length>1` (401); es la garantía de que «en el peor caso todavía se puede descargar directo».

### Quién lo llama
- `src/core/provision.js:16` (require), `:145` (`new Sources(() => store.getSettings())`), `:149-151` (`get sources`), `:535` (`rank`), `:588` (`candidates`, `_downloadUrls`).
- `src/core/updater.js:23,47` (`new Sources(this.settings)`), `:74` (`latest`), `:140-141` (`candidates`+`rank`), `:191-196` (`candidates`+`rank` para cada parte).
- `src/main.js:819-825`: si en la configuración cambian `sourcePreference/mirrorPrefix/autoMirror` → `updater.sources.reset()` + `provisioner.sources.reset()`. **Ojo**: aquí no se borran `provisioner._cache.pack / emulatorUrl / sysimgUrl / playUrl` (ver trampas de §3).

### Cobertura de pruebas (`test/auto-test.js`)
- ✓ `:843` Las direcciones candidatas llevan prefijo de espejo; el prefijo propio tiene prioridad sobre los espejos públicos
- ✓ `:864` Se ordena por velocidad medida; si todas fallan se mantiene el orden sin perder direcciones (y se verifica `reset()`)
- ✓ `:878` El paquete de código fuente que agrega Gitee (`v1.2.3.zip`) nunca se toma como instalador
- ✓ `:901` Los recursos de Gitee no tienen `size`: el grupo de partes sigue siendo válido
- ✓ `:926` Los recursos en partes deben llegar hasta `updater.asset`
- ✓ `:949` Al combinar versiones solo cuentan los recursos de la misma versión
- ✓ `:976` Si las dos fuentes tienen el mismo paquete entero, se conservan ambas direcciones
- ✓ `:1282` Caché de versiones de 10 minutos; `force` obliga a volver a consultar
- ✓ `:1300` Cortacircuitos por 403 + texto de `blockedReason` + liberación con `reset()`
- ✓ `:1323` Si ninguna fuente responde se vuelve al último resultado (`stale`)

---

## 2. `src/core/download.js` — una conexión / bloques / varias fuentes en paralelo + reanudación + vigilante

### Responsabilidad
Descargador de cuatro niveles que solo depende de `http/https/fs`: una conexión con reanudación → bloques de una fuente → bloques de varias fuentes (suma de ancho de banda) → cambio de fuente en orden; todo con vigilante de inactividad y protección de «resolución garantizada».

### Interfaz pública

| Exportación | Firma | Devuelve |
|---|---|---|
| `openStream` | `(url, {method='GET', headers={}, redirects=0}) => Promise<IncomingMessage>` | Sigue 301/302/303/307/308 (≤6 saltos), tiempo de inactividad del socket 30 s (15-36) |
| `head` | `(url) => Promise<{status,size,type,error?}>` | Nunca lanza; si falla `status:0` (38-50) |
| `sha256File` | `(file) => Promise<hex>` | 52-60 |
| `download` | `(url, dest, opt) => Promise<{file,size}>` | `opt = {onProgress,signal,expectSha256,retries=2,idleMs=30000}` |
| `downloadParallel` | `(url, dest, opt) => Promise<{file,size,parallel:n}>` | `opt += {connections=8,minChunk=1MB,retries=3}` |
| `downloadAny` | `(urls, dest, opt) => Promise<{file,size,url}>` | Prueba en orden; si todas fallan lanza un error agregado (314-326) |
| `downloadMulti` | `(urls, dest, opt) => Promise<{file,size,parallel,sources,multi,resumed}>` | `opt += {minChunk=2MB,retries=6,idleMs=20000,slowAfterMs=45000,slowBps=120*1024}` (338-548) |
| `downloadAnyParallel` | `(urls, dest, opt) => Promise<{file,size,url}>` | Usa `downloadParallel` en orden (551-563) |

Cuerpo del callback `onProgress`: `{got,total,percent,speed,eta}` (`downloadMulti` agrega `sources`).

### Implementación clave

**1) `download()`: una conexión + reanudación (68-173)**
- Antes de cada intento `statSync(dest).size` → `Range: bytes=existing-` (75-77);
- `416` se toma como «ya completo» y hace `break` (82-86);
- `200` con `existing>0` = el servidor no admite reanudación → `rmSync` y se reescribe (97-100);
- Si no es 200/206: hasta `retries=2` reintentos, **espera fija de 1500 ms** (87-90);
- Vigilante de inactividad `idleMs` (30 s por defecto): `kick()` se reinicia con cada dato recibido; al vencer `res.destroy()` + `finish(Error('conexión detenida (mucho tiempo sin datos)'))` (112-130). El comentario (109-111) registra: cuando la conexión queda en silencio `res` no emite ni `end` ni `error`, `pipe` nunca termina y toda la descarga se cuelga sin error;
- `signal.abort` → `res.destroy(new Error('cancelado'))` (132-133);
- Al terminar fuerza `onProgress({percent:100})` (162-163); si `expectSha256` no coincide → borra el archivo + lanza error (165-171).

**2) `downloadParallel()`: bloques de una sola fuente (180-311)**
- Si ya hay un archivo no vacío → vuelve a `download()`, para no perder el estado de los bloques (188-191);
- Sondea Range con `Range: bytes=0-0`; solo con 206 + `content-range` va en paralelo; con `total < minChunk*2` también vuelve a una conexión (193-210);
- `n = min(connections, ceil(total/minChunk))`, `per = ceil(total/n)` (212-213);
- Primero `ftruncateSync(fd,total)` crea el archivo vacío y luego cada bloque escribe en su posición con `fs.writeSync(fd, buf, 0, len, pos)` (219-220, 268);
- Cada bloque hasta `retries=3`, con espera `800 * tries` ms (285-300);
- Al terminar verifica `size === total`; si no, lanza «descarga incompleta» (307-310).

**3) `downloadMulti()`: bloques de varias fuentes (338-548)**
1. `list = sin duplicados(urls)`; si solo hay una → `downloadParallel` (350-352);
2. `Promise.all` sondea en paralelo el tamaño total de `content-range` de cada dirección (355-365); si ninguna admite Range → `downloadAnyParallel` (367-370);
3. **El tamaño total de referencia es `usable[0].total`**, el primero ordenado por `rank()` (la fuente más rápida), no `Math.max` (371-377); solo se mezclan fuentes con `total === ese valor` (378-381);
4. `n = clamp(2..connections, ceil(total/minChunk))`; los bloques se reparten entre fuentes rotando con `i % same.length` (384, 409-416);
5. **Archivo auxiliar de reanudación por bloques** `${dest}.chunks.json` (391-405): solo vale si `m.total===total && m.n===n && tamaño de dest===total`; si no, se borran el archivo y el auxiliar y se descarga de nuevo. Los bloques terminados hacen `doneSet.add(c.start)` + `saveMeta()` (518-520);
6. Al reanudar los bloques terminados cuentan en `got`, así el progreso no vuelve a 0 (425-427);
7. **Cambio de fuente por lentitud**: si un bloque lleva `slowAfterMs=45s` con media < `slowBps=120KB/s` y `c.rotates < 2` → `res.destroy()` + lanza «esta fuente es demasiado lenta… se cambia de fuente», conservando `c.pos` (446-451, 492-503). El comentario nombra el síntoma: **«atascado en 95 %»**;
8. Cada bloque `retries=6` (comentario: 3 no bastan cuando «dos de tres fuentes se paran a veces»); al fallar `c.src += 1` cambia de fuente, con espera `600 * tries` (523-534);
9. Al salir con fallo hace `saveMeta()` y luego lanza (526-528); al terminar bien `rmSync(meta)` (542).

**10) Doble seguro de «resolución garantizada»**: `fetchChunk` mantiene su propio `settled` + `finish()`, y el vigilante llama directamente a `finish`, porque `res.destroy(err)` a veces solo emite `close` y no `error` (466-480).

### Trampas e invariantes

- **Solo se pueden mezclar fuentes que «declaran el mismo tamaño total»** (371-381); si no, se uniría un archivo dañado; con tamaños distintos (GitHub/Gitee comprimen cada uno el suyo) solo se usa la más rápida.
- **`c.rotates` debe inicializarse explícitamente a 0** (comentario en 415): `undefined < 2` es `false` y el cambio de fuente nunca se dispararía (error histórico).
- **Cada petición solo puede cambiar de fuente una vez** (459-463): tras `destroy`, la misma conexión aún puede recibir paquetes en búfer, que dispararían el cambio de nuevo y se saltarían fuentes.
- **La reanudación solo funciona en `download()` y `downloadMulti`**; `downloadParallel` degrada a una conexión al ver un archivo a medias (188-191): es una decisión de diseño, no un error.
- `provision.installQemu:1100` pasa `{ resume: true }`, pero `download()` no tiene la opción `resume` (69); la reanudación es automática: **ese parámetro no sirve / es un resto histórico**.
- `downloadMulti` no maneja `opt.signal` (solo `download()` lo hace); hoy una descarga multifuente solo se cancela por tiempo límite/error.
- La rama `416` de `download()` hace `break` y toma el «archivo existente» como completo (82-86); si `existing > total` (escritura dañada la vez anterior) no se autocorrige; solo `expectSha256` lo detecta.
- El `timeout: 30000` de `openStream` es el tiempo de inactividad del socket, **no hay un tiempo límite de conexión aparte**; si el DNS se cuelga, lo cubren los temporizadores externos de `measure/rank`.
- El UA en `download.js:13` es `LanzadorAPK/0.2` y en `sources.js:64` es `LanzadorAPK/0.3`; no coinciden (sin efecto funcional, solo en registros/estadísticas del servidor).
- Invariante: el `onProgress` de todas las funciones de descarga se llama siempre una vez con `percent:100` antes de terminar bien (163, 308, 545), así la interfaz no se queda en 99 %.

### Quién lo llama
- `src/core/provision.js:14` (require), `:434` `downloadAny` (adb), `:541` `downloadMulti` (paquete completo del runtime), `:912` `downloadAnyParallel` (emulator), `:1010` (imagen play), `:1052` (aehd), `:1143` (ISO), `:628-629`/`:1071-1072` `openStream` (índices/páginas de carpetas), `:1226-1228` `head` (`probeSources`).
- `src/core/updater.js:20,150` (`downloadMulti` del paquete de actualización), `:198` (`downloadAnyParallel` para cada parte).
- `test/engine-test.js:32`; `test/boot-test.js:23,38` (descarga real de la ISO, con `test:boot`).

### Cobertura de pruebas
`test/engine-test.js`
- ✓ `:83` Descarga completa + seguir redirecciones
- ✓ `:89` Reanudación (ya hay un archivo a medias)
- ✓ `:101` Sondeo HEAD + SHA256
- ✓ `:108` Si falla la verificación SHA256 se borra el archivo
- ✓ `:118` Descarga por bloques en paralelo: el contenido unido de varias conexiones coincide
- ✓ `:133` Si la fuente no admite Range se vuelve sola a una conexión

`test/auto-test.js` (levanta un servidor http local que envía bytes reales)
- ✓ `:995` Descarga multifuente en paralelo: con tamaños distintos se sigue a la fuente más rápida
- ✓ `:1068` Bloques distintos de fuentes distintas; los bytes unidos deben ser idénticos
- ✓ `:1108` Al reintentar tras un fallo solo se completan los bloques que faltan (archivo auxiliar)
- ✓ `:1155` Si tras conectar no llega ni un byte, debe agotar el tiempo y cambiar de fuente, no colgarse
- ✓ `:1198` Si una fuente va a unas decenas de KB/s se cambia, en vez de quedarse en los últimos %
- ✓ `:1251` Con una sola dirección disponible se vuelve a bloques de una fuente
- ✓ `:1033` El paquete de actualización en partes se une en orden y se detiene si el tamaño no coincide (`updater._downloadParts`)

---

## 3. `src/core/provision.js` — arranque inicial del runtime (adb / emulator / system image / qemu / aehd)

### Responsabilidad
Sin depender de emuladores de terceros, hace «descargar → verificar → descomprimir/instalar → guardar» de adb, emulator, imágenes del sistema, AEHD, QEMU y discos virtuales, y gestiona dónde va cada archivo (`paths()`), si hay espacio (`guardDisk`) y si está instalado (`checkEnv`).

### Interfaz pública (`class Provisioner`, exporta `{Provisioner, SOURCES, MIN_SIZE, absUrl, baseOf}`)

| Miembro | Firma | Descripción |
|---|---|---|
| `constructor` | `(appRoot)` | 140-146; internamente `_sources = new Sources(() => store.getSettings())` |
| `get sources` | `Sources` | 149-151; comparte con updater la configuración de espejos/medición |
| `get root` | `string` | `settings.runtime.dir` o `%APPDATA%\lanzadorapk\runtime` (192-195) |
| `paths()` | `Paths` | 197-245, ver la tabla de abajo |
| `ensureDirs()` | `Paths` | Crea root/qemu/platform-tools/images/_tmp/avdHome (247-253) |
| `guardDisk` | `(component, targetDir) => Promise<freeMB>` | Si no hay espacio lanza un error legible (262-277) |
| `hypervisor` | `() => Promise<{whpx,dll,hypervisorPresent,note}>` | Solo comprobaciones de archivos de milisegundos (281-296) |
| `adbVersion` / `qemuVersion` / `emulatorVersion` | `() => Promise<{ok,path,version}>` | Cada uno con caché en memoria de 30 s (298-338, 687-714) |
| `inspectIso` | `(file) => {ok,iso9660,rawImage,size,reason,magic}` | Lee `CD001` en `0x8001` (341-365) |
| `checkEnv` | `() => Promise<Env>` | 367-424; todo el «estado» de la interfaz depende de esto |
| `installAdb` | `(onProgress) => {ok,path,version}` | 428-456 |
| `resolveRuntimePack` | `() => {url,name,size,tag,page,from}` | 476-516; busca `LanzadorAPK-runtime-*.zip` en Gitee/GitHub en paralelo |
| `installRuntimePack` | `(onProgress) => {ok,name,tag}` | 522-580; implementación en un clic de la versión ligera |
| `extractZip` | `(zipPath,destDir,{onEntry}) => destDir` | 591-622; >64 MB usa el zip desde archivo y las entradas grandes en flujo |
| `resolveEmulatorUrl` / `resolveSysimgUrl` / `resolvePlayUrl` / `resolveQemuUrl` | `() => Promise<string>` | Se resuelven dinámicamente desde los índices/páginas de Google, con constantes de respaldo |
| `materializeImages` | `(onLog) => Promise<count>` | 722-794; `.img.xz/.gz` → `.img` (solo una vez) |
| `systemImageInfo` / `playImageInfo` | `() => {ok,dir,size,api,tag?,note?}` | 797-839 / 972-980 |
| `emulatorAccel` | `() => Promise<{ok,kind,note,...}>` | 845-902; `-accel-check` + caché en disco |
| `installEmulator` | `(onProgress) => {ok,path,version}` | 905-937 |
| `ensurePlatformTools` / `adbVersionPath` | `() / () => bool / string` | 940-955 / 957-963 |
| `installSystemImage` | `(onProgress)` | 966-969; equivale a `installPlayImage` (solo hay una imagen base) |
| `installPlayImage` | `(onProgress) => playImageInfo` | 1004-1044; de paso limpia `android-30` |
| `installAehd` | `(onProgress) => {ok,dir,installer}` | 1047-1062; solo descarga, no instala |
| `installQemu` | `(onProgress) => {ok,path,version}` | 1090-1130; instalación silenciosa NSIS `/S /D=` |
| `downloadIso` / `inspectImage` / `importIso` / `importDisk` | | 1134-1195 (ruta QEMU) |
| `createDisk` | `(sizeGB=24, onProgress)` | 1199-1220; `qemu-img create -f qcow2` |
| `probeSources` | `() => {adb,qemu,iso}` | 1224-1231; sondeo HEAD de tres URL fijas |
| `envCacheGet/Set`, `invalidateEnvCache`, `_envKey` | | 154-188; caché en disco de la detección del entorno |

Lo que devuelve `paths()` (225-245):

```js
{ root, qemuDir, qemuExe, qemuImg,
  adbDir, adbExe,
  emulatorDir, emulatorExe,
  sysImgRoot,                       // ★ ver las tres ramas de abajo
  sysImgDir: <sysImgRoot>/android-34/google_apis_playstore/x86_64,
  avdHome, aehdDir,
  imagesDir, iso, disk, tmp,
  sysTag:'google_apis_playstore', sysApi:'34', sysAbi:'x86_64' }
```

Lo que devuelve `checkEnv()` (387-423):

```js
{ adb:{ok,path,version,required}, emulator:{ok,path,version,required,note},
  sysimg:{ok,dir,size,api,required,note}, playImage:{ok,dir,size,...},
  accel:{ok,kind,note}, qemu:{ok,...}, iso:{ok,path,size,iso9660,reason,...},
  disk:{ok,path,size,note}, hypervisor:{...},
  ready, engine:'emulator'|'qemu'|'none', paths }
```
`ready = adb.ok && (emulatorReady || qemuReady)`; `emulatorReady = emulator.ok && (sysimg.ok || playImage.ok)` (384, 420).

### Implementación clave

**1) Las tres reglas de rutas de `paths()` (197-245): la única autoridad sobre «en qué disco termina la imagen»**

- `root`: `settings.runtime.dir`; si está vacío, `%APPDATA%\lanzadorapk\runtime` (192-195).
- `avdHome` (237): `settings.runtime.avdDir`; si no, **si root no está bajo `DATA_DIR`** se usa `<DATA_DIR>/avd`, y si no, `<root>/avd` (202-209). Motivo (202-206): el runtime de la distribución de archivo único se descomprime en una carpeta temporal y poner ahí el AVD haría perder las apps en cada salida.
- Las tres ramas de `sysImgRoot` (217-224):
  1. Ya existe `<root>/system-images` → se usa (resultado de descomprimir el paquete completo);
  2. Si no, existe `<DATA_DIR>/system-images` → se usa (distribución de usuarios viejos/archivo único);
  3. Si no existe en ninguno → **va a `<root>/system-images`** (instalación nueva; el comentario explica que el ensamblado del runtime en CI depende de esto y que `DATA_DIR` puede estar redirigido a una carpeta temporal).

**2) `materializeImages()` (722-794)**
- La carpeta de origen es siempre `<root>/system-images` (723) y **la de destino `this.paths().sysImgRoot`** (726); el comentario exige que ambas sigan la misma regla; si no, pasa que «el paquete se descomprime en D: y la imagen vuelve a descomprimirse en AppData de C:» (en pruebas reales convivían 1,2 GB + 3,3 GB).
- Recorrido: `.img.xz` tiene prioridad sobre `.img.gz` (Map `found`, 729-741); los demás archivos (`kernel-ranchu` / `ramdisk.img` / `.img` sin comprimir) **deben copiarse también** (728, 751-760); si no, el emulador dice «falta la imagen del sistema».
- Decisión de ya descomprimido: con `fileSize(dest) > 32MB` se omite (765).
- Para descomprimir `.xz` hay que saltarse la entrada ESM del paquete (771-781): `require.resolve('@napi-rs/lzma')` da la carpeta y luego `require(dir/index.js)`; el comentario explica que el Node 20 de Electron no admite `require('stream-polyfill.mjs')` y que `exports` no deja escribir `/index.js` directamente.
- Si falla una imagen solo hace `onLog('Error al descomprimir la imagen: …')` (790) y **no lanza hacia arriba**.

**3) `installRuntimePack()` (522-580): el «un clic» de la versión ligera**
- `resolveRuntimePack()`: primero la dirección propia `settings.runtime.runtimePackUrl` (477-478, `size:0`); el resultado se guarda en `this._cache.pack`, **que nunca se invalida** (479, 514);
- Consulta en paralelo `releases?per_page=15` de GitHub/Gitee, busca en `assets` `/^LanzadorAPK-runtime-.*\.zip$/i` y toma el tag más alto con `cmpVer` (487-515);
- `guardDisk('runtime', p.root)` (525) → **`'runtime'` no está en la tabla `need`**, así que cae en el default de 512 MB + 1024 MB de margen = 1536 MB (264-266);
- `rank(this._downloadUrls(pack.url))` mide la velocidad (534-536); si falla, vuelve a las candidatas originales;
- `downloadMulti(urls, tmp/runtime-pack.zip, {connections: settings.runtime.downloadConnections||8})` (529, 541-555); **
  progreso mapeado como `percent = clamp(1..90, pct*0.9)`** (551);
- Control de tamaño: con `< 200MB` lanza «la descarga del paquete del runtime está incompleta; se puede reintentar y reanudar» (556);
- `extractZip(zip, p.root, {onEntry})` (559-565), progreso 91→99;
- Escribe la marca `<root>/.runtime-pack.json` (`{name,tag,at,from}`) y borra el zip (566-571);
- **De inmediato** `materializeImages(...).catch(() => 0)` (573-576); el comentario explica que si no, el `checkEnv()` siguiente creería que no hay imagen y bajaría otra vez 1,4 GB de Google;
- Devuelve `{ok,name,tag}`, progreso 100.

**4) `extractZip()` (591-622)**
- `fileSize > 64MB` → `new ZipFile(path)` (sin cargar todo el paquete en memoria); si no, `new ZipArchive(fs.readFileSync(...))`;
- Las entradas con `uncompSize > 64MB` van en flujo con `zip.pipeTo()`; el resto con `fs.writeFileSync(zip.read())`;
- `finally { zip.close() }` (618-620).

**5) `checkEnv()` (367-424)**: `Promise.all` lanza 5 detecciones (adb/qemu/hypervisor/emulator/accel), y se suman `inspectIso`, `fileSize(disk)`, `systemImageInfo()`, `playImageInfo()`; `sysimg.ok` se define como `systemImageInfo().ok || playImageInfo().ok` (381-399).

**6) Caché en disco de la detección del entorno (126-188)**
- Archivo: `%APPDATA%\lanzadorapk\cache\env.json` (129-131);
- key = `ruta del exe + exe(size:mtime) + aehd.sys(size:mtime) + si existe WinHvPlatform.dll` (154-162);
- TTL: conclusión disponible 6 h (126), **no disponible solo se cree 10 minutos** (127; el usuario puede acabar de activar la virtualización);
- Si el arranque falla, emulator llama a `invalidateEnvCache()` (`emulator.js:848,886`).

**7) `emulatorAccel()` (845-902)**: analiza el texto de `-accel-check`; tres reglas de respaldo: falta `emulator-check` pero hay `aehd.sys` → disponible (879-883; el comentario explica «para no concluir por error que no hay aceleración y forzar `-accel off`, porque la emulación por software se cae directamente en algunos equipos»); `hasAehdFile && /aehd/` → disponible (884); `hv.dll && /whpx/` → disponible (886); si no, `viaTcg: true` (888-897).

**8) Guardia de disco `guardDisk()` (262-277)**

| component | need(MB) | + buffer 1024MB |
|---|---|---|
| adb | 64 | 1088 |
| emulator | 600 | 1624 |
| sysimg / playimg | 1800 | 2824 |
| qemu | 320 | 1344 |
| iso | 1100 | 2124 |
| aehd | 64 | 1088 |
| No listado (como `'runtime'`) | 512 | **1536** |

Si no alcanza lanza: «Espacio insuficiente en el disco de destino: este componente necesita unos N MB… cambia la "carpeta de datos del runtime" a un disco con más espacio (Configuración → Integración con el sistema → Carpeta de datos del runtime → Examinar)».

### Trampas e invariantes

- **La ubicación de la imagen debe coincidir con `paths().sysImgRoot`**: `installPlayImage` descomprime en `p.sysImgRoot` (1023), el destino de `materializeImages` es `paths().sysImgRoot` (726) y `playImageInfo` busca en `p.sysImgRoot` (974). Cualquier código nuevo que arme por su cuenta `<DATA_DIR>/system-images` reproducirá «configuré la carpeta del runtime y sigue descargando a AppData».
- **La estimación de `guardDisk('runtime')` es baja**: 512+1024=1536 MB, cuando en realidad son «paquete de 1,5 GB + zip en disco + 3,3 GB de system.img descomprimido + descompresión .xz». En discos pequeños falla durante la descompresión y deja archivos a medias (`installRuntimePack` no limpia el zip a medias; depende de la siguiente reanudación).
- **`this._cache.pack` / `emulatorUrl` / `sysimgUrl` / `playUrl` no tienen forma de invalidarse**: `main.js:819-825` solo hace `sources.reset()`. Si el usuario cambia `sourcePreference` o la dirección del paquete, el mismo proceso sigue usando la dirección vieja (salvo `runtimePackUrl`, porque siempre lee primero la configuración, 477).
- **Los fallos de `materializeImages` se tragan en dos lugares**: su propio `.catch(e => onLog(...))` (790) + el `.catch(() => 0)` del llamador (576). Si falta `@napi-rs/lzma` o lo bloquea el antivirus → la imagen nunca se descomprime → `checkEnv().sysimg.ok === false` → cada inicio vuelve a la ruta «descargar el runtime» (el típico «atascado preparando el runtime»).
- **Los fallos de `emulatorVersion()` no se guardan en caché** (687-714): `ok:false` devuelve directamente, sin `envCacheSet` ni caché en memoria de 30 s; cada `checkEnv()` ejecuta `execFile(emulator.exe -version)` hasta 20 s. Solo la ruta de éxito escribe la caché (707-710).
- **La caché de `emulatorVersion` solo está en memoria/disco y `_cache.emulatorVerAt` solo se fija al tener éxito**; la ruta de fallo hace que el sondeo de estado lance el proceso una y otra vez.
- **`extractZip` no comprueba zip-slip**: une directamente con `path.join(destDir, name)` (606); `updater._extract` sí se protege con `startsWith(path.resolve(dest))` (updater:237); no es coherente. El paquete del runtime y los de actualización vienen de los release del propio proyecto y el riesgo es bajo, pero quien tome el proyecto no debe usar `extractZip` con entradas no fiables.
- **La dirección propia de `resolveRuntimePack()` tiene `size: 0`**; el progreso de descarga solo puede salir del sondeo o de los bytes recibidos; por eso en `installRuntimePack` `total` también es 0 y al texto de `mb` le falta el «/ tamaño total».
- **`installAdb` descomprime en `p.root`** (446); el nivel superior del zip ya es `platform-tools/`; igual con `installEmulator` (926). Por eso root es a la vez `ANDROID_SDK_ROOT` (comentario de 232-234).
- **`ensurePlatformTools()` (939-955)**: emulator exige `platform-tools` bajo la raíz del SDK; si no, da FATAL; copia 3 archivos (`adb.exe` + dos dll) desde `engine/platform-tools`, `tools/platform-tools` o la carpeta de `settings.adbPath`.
- **`installAehd` solo descarga** (1047-1062); instalar requiere administrador: `main.js:1121-1200` usa `silent_install.bat` + UAC.
- **Instalación de QEMU**: NSIS `/S /D=<dir>`; `/D` debe ir al final y sin comillas (1112-1116); a los 600 s `setTimeout` lo mata a la fuerza (1119).
- **`systemImageInfo()` (797-839)**: busca primero en `paths().sysImgDir` y luego enumera todos los `android-*/tag/abi` de `sysImgRoot`, `<root>/system-images` y `<appRoot>/engine/system-images` (por API descendente); cualquiera con `system.img > 300MB` y `kernel-ranchu` vale. Es el punto de compatibilidad para «la versión completa podría traer solo una imagen AOSP más pequeña».
- **Relación entre `playImageInfo()` y `sysimg.ok`**: `checkEnv().sysimg.ok` combina ambos con OR (390-399), pero `engine.ensure()` usa `env.sysimg.ok` (`engine.js:852`), así que con solo la imagen play también arranca.
- **Invariante**: el `onProgress` de todos los `install*` reporta con la forma `{stage:'download'|'extract'|'install'|'done', percent}`; `main.js:317` agrega `component` y en la interfaz `app.js:357 updateStepProgress` solo lee `percent/message`.
- Las versiones de respaldo fijas en `SOURCES` se quedarán viejas (`emulator-windows_x64-16847572.zip`, `x86_64-34_r14.zip`, 27-41); solo se usan si no se puede leer el índice.

### Quién lo llama
- `src/core/engine.js:16,54` (`new Provisioner(appRoot)`), `:79,202,393,995` (`paths()`), `:109,235,368,635,849,996` (`checkEnv`), `:264,761` (`emulatorAccel`), `:639` (`createDisk`), `:848` (`materializeImages`), `:1017,1021` (`paths().root` → layers), `:873` (`needsSetup`).
- `src/core/emulator.js:17,29`, `:53,225` (`paths`/`ensureDirs`), `:56,63` (`systemImageInfo`), `:62,723` (`playImageInfo`), `:659` (`adbVersionPath`), `:761-762` (`emulatorAccel`+`emulatorVersion`), `:848,886` (`invalidateEnvCache`).
- `src/core/installer.js:95-99` (`playImageInfo` + `installPlayImage`, se descarga bajo demanda la primera vez que aparece una app ARM); `:159,169,190,489` (decisiones con `playImageInfo`).
- `src/main.js`: `:314-354` (flujo principal de `autoDeploy`), `:707` (`paths().root` para la interfaz), `:824` (`sources.reset`), `:898,932,939,946,953,964,977` (autocomprobación/diagnóstico), `:1076-1269` (los IPC `provision:*`), `:1330,1542` (`avdHome`/`root`), `:1631` (`checkEnv` antes del precalentamiento).
- `test/engine-test.js:146-220,391-401`, `test/auto-test.js:1347-1350`, `test/boot-test.js:44`.

### Cobertura de pruebas
`test/engine-test.js`
- ✓ `:149` La carpeta del runtime por defecto está dentro de la carpeta de datos
- ✓ `:156` Comprobación con entorno vacío: adb no listo, estructura de componentes completa
- ✓ `:166` La descompresión ZIP incluida funciona
- ✓ `:197` Las url relativas del índice del SDK se completan como absolutas (`absUrl`/`baseOf`)
- ✓ `:211` Las direcciones de emulator / imagen del sistema son URL absolutas descargables
- ✓ `:244` Verificación de imagen: distingue ISO9660 válida / dañada / sin terminar (`inspectIso`)
- ✓ `:391` `playImageInfo` verifica la integridad de la imagen compatible API 34

`test/auto-test.js`
- ✓ `:1339` **Ubicación de la imagen del sistema: una instalación nueva debe ir a la carpeta del runtime** (cubre las tres ramas de `paths().sysImgRoot`)

`test/boot-test.js:44` ejecuta un `checkEnv` real + arranque real (`npm run test:boot`; funciona sin red pero necesita la ISO).

**Sin cobertura**: `installRuntimePack`, `resolveRuntimePack`, `materializeImages`, `installAdb/installEmulator/installPlayImage/installAehd/installQemu` y `guardDisk` no tienen pruebas unitarias (todos necesitan red real/archivos grandes).

---

## 4. `src/core/updater.js` — actualización en línea (check / prepare / apply)

### Responsabilidad
Toma la última versión de los Releases de GitHub/Gitee de este repositorio, elige el recurso según la forma de instalación, descarga y arma la carga, y genera un script de PowerShell de sobrescritura que tras salir el proceso hace «reemplazar + reiniciar».

### Interfaz pública (exporta `{Updater, cmpVer, OWNER, REPO}`)

| Miembro | Firma | Descripción |
|---|---|---|
| `constructor` | `({currentVersion, exePath, isPackaged, dataDir, settings?, onProgress?})` | 38-50; `this.installDir = dirname(exePath)`, `this.sources = new Sources(settings)` |
| `get flavor` | `'setup' \| 'portable'` | 53-59: si en `installDir` hay `Uninstall *.exe` → `setup` |
| `get updateDir` | `<dataDir>/update` | 61-63 |
| `check` | `({force=false}) => Promise<Latest>` | 73-115, ver abajo |
| `prepare` | `(info?) => Promise<{mode:'zip'\|'setup', payload, version}>` | 121-176 |
| `_downloadParts` | `(asset, target, conns, total)` | 182-227; descarga de partes + unión en orden |
| `_extract` | `(zipPath, dest)` | 229-251; con protección zip-slip, entrada por entrada en flujo |
| `apply` | `(job, {waitPid?, spawn?}) => true \| script` | 258-325; con `spawn:false` solo devuelve el script (para pruebas) |
| `static repoUrl()` | `() => 'https://github.com/zaiddia/Lanzador-APK/releases'` | 328-330 |
| `cmpVer` | reexportado de `version.js` | 333 |

Lo que devuelve `check()` (82-112):

```js
{ version, tag, name, notes, htmlUrl, publishedAt,
  asset: { name, size, url, urls[], sizes{}, source, parts?, partial? } | null,
  assets, sources, unreachable,
  flavor, hasUpdate, current, canAutoApply }
```
Elección de `asset` (77-80):
- `setup`: `/Setup\.exe$/i` → respaldo `/win.*\.exe$/i`
- `portable`: `/portable.*\.zip$/i` → `/win64.*\.zip$/i` → **`/\.zip$/i`**
`hasUpdate = cmpVer(merged.tag, current) > 0` (109); `canAutoApply = !!asset && (asset.url || asset.parts?.length)` (111).

### Implementación clave

**1) `check()` (73-115)** solo hace «metadatos + elegir recurso»; la velocidad de las direcciones se mide en `prepare()`. `force` se pasa tal cual a `sources.latest`.

**2) `prepare()` (121-176)**
- Carpeta de la carga `<dataDir>/update/<version>/`;
- Si hay `asset.parts` → `_downloadParts` (133-134);
- Si no, `candidates(asset)` → `rank()` → `downloadMulti(ranked, file, {connections})` (136-163);
- **Cómo se toma el tamaño total del progreso**: el primer `sizes[url]` conocido en el orden de `ranked` (142-147); el comentario explica que equivocarse hace que «muestre 92 % todo el rato y de golpe salte a terminado»;
- `.zip` → se descomprime en `payload/` → `{mode:'zip',payload:out}`; el resto → `{mode:'setup',payload:file}` (166-175).

**3) `_downloadParts()` (182-227)**: cada parte hace su propio `candidates + rank` (unas pueden ir por Gitee y otras por espejo), `downloadAnyParallel` a `<name>.<index>.tmp`, verifica `part.size` (si se conoce, 211-216), escribe en orden con `fs.writeSync(fd, buf, 0, len, doneBytes)` y al final verifica `doneBytes === total` (224-226). Cada parte entera se carga en memoria con `readFileSync` (213); con partes ≤100 MiB es aceptable.

**4) `apply()` (258-325): la parte más crítica de la cadena de actualización**
El script generado (`lines`, 265-307) hace en orden:
1. `$ErrorActionPreference='SilentlyContinue'`; `Note()` escribe en `<updateDir>/update.log`;
2. `Wait-Process -Id <waitPid> -Timeout 90` + `Sleep 700ms` (270-272);
3. `mode==='zip'`: `Copy-Item -Recurse -Force` **hasta 12 rondas**, usando «si existe el exe de destino» como sonda, con `Sleep 600ms` si falla (275-290); después `Remove-Item $src` (la carpeta descomprimida, 289);
4. `mode==='setup'`: `Start-Process -ArgumentList '/S' -Wait` y registra el exit code (291-298);
5. Vuelve a lanzar el `exe` (300-301);
6. `Remove-Item <updateDir>/<version> -Recurse -Force` y al final **`exit 0`** (304-306; comentario: un fallo de limpieza no debe hacer creer al llamador que la actualización falló).

Forma de lanzarlo (309-324):
- El script se escribe primero en `update/apply.log.ps1` para diagnosticar (310);
- Se ejecuta con `-EncodedCommand` (base64 UTF-16LE, 313); el comentario explica que así **se evita que PS 5.1 decodifique como ANSI/GBK los scripts sin BOM** y corrompa las rutas con caracteres no ASCII;
- **No puede ser `detached`** (315-318): algunos programas de seguridad/entornos aislados bloquean los «procesos de consola separados», y el síntoma es que el script ni se ejecuta (la interfaz queda en «Reemplazando el programa y reiniciando»); se usa un proceso hijo normal + `child.unref()`;
- `spawn(ps, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand',b64], {stdio:'ignore', windowsHide:true})`.

### Trampas e invariantes

- **Versión instalada vs portátil se decide por «si hay `Uninstall *.exe` en la carpeta de instalación»** (53-59), sin otra marca; NSIS sobrescribe en silencio y la portátil sobrescribe copiando.
- **La sobrescritura no borra los archivos que sobran de la versión vieja** (comentario de 287-288), solo limpia la carpeta descomprimida de esta vez; así que «dll borradas que quedan» podrían afectar a la versión nueva (por ahora se considera inofensivo).
- **Tras `apply()` el llamador debe salir**: `main.js:594-596` hace `app.quit()` 900 ms después de `apply(job)`; el script espera hasta 90 s.
- **Gitee 100 MiB → `.part1/.part2`** (comentario de 130-134); `sources.latest` ya une las partes en un recurso lógico y `check()` debe llevar `parts` hasta el final (88-101); auto-test:926 vigila justo esto.
- **`sizes` se guarda por dirección**; no basta con un `asset.size` único (142-147, sources:339-347).
- **Posible confusión: el respaldo por defecto `/\.zip$/i` tomaría el paquete completo del runtime como actualización** (80). En un mismo release están `LanzadorAPK-vX-win64-portable.zip` y `LanzadorAPK-runtime-vX.zip` (`.github/workflows/release.yml:44,187`); hoy no falla porque la regex `portable` coincide antes; si el paquete portátil cambia de nombre, `/\.zip$/i` elegiría el paquete de 1,5 GB del runtime y sobrescribiría la carpeta del programa.
- **`prepare` no verifica la integridad zip de lo descargado**; los errores solo aparecen en `_extract`; si el tamaño descargado no coincide con `total`, `downloadMulti` lanza (download:546).
- **Solo se buscan actualizaciones en la versión empaquetada**: `main.js:1665 if (app.isPackaged)`; en desarrollo no se busca.
- Invariante: `apply()` debe llamarse después de un `prepare()` correcto (`prepare` lanza si no hay carga; `main.js:592` lo captura y hace `sendProgress({stage:'error'})`).
- `flavor` hace `readdirSync(installDir)` cada vez, sin caché (53-59); llamarlo muy seguido genera E/S de disco; hoy solo lo usan check/la interfaz.

### Quién lo llama
- `src/main.js:38` (require), `:1503-1511` (construcción, inyecta `settings`/`onProgress`), `:579-604` (`runUpdate`: `check`→`prepare`→`apply`→`quit`), `:496,584,588` (bandeja/comprobación manual + `repoUrl()`), `:1447` (`app:updateCheck`, `force` verdadero por defecto), `:1456` (`app:updateOpen`), `:1461` (`app:updateApply`), `:1667` (comprobación silenciosa a los 8 s de iniciar).
- `src/preload.js:71-72` (`updateCheck` / `updateApply`); en `src/ui/app.js`, «Actualizaciones» de la configuración.

### Cobertura de pruebas (`test/auto-test.js`)
- ✓ `:820` La comparación de versiones es numérica por partes (`cmpVer`)
- ✓ `:828` La forma de instalación decide el recurso + decisión de `flavor`
- ✓ `:926` Los recursos en partes deben llegar hasta `updater.asset` (si no, `prepare` dice «no hay direcciones de descarga disponibles»)
- ✓ `:1033` El paquete de actualización en partes se une en orden y se detiene si el tamaño no coincide (`_downloadParts`)
- Cobertura indirecta: `:843/:864/:878/:901/:949/:976` (`sources`), `:995/:1068/:1108/:1155/:1198/:1251` (`downloadMulti`)
- **Sin cobertura**: el contenido del script que genera `apply()` (ninguna aserción revisa `apply.log.ps1`), el zip-slip de `_extract` y la elección de `sizes` en `prepare`.

---

## 5. `src/core/store.js` — persistencia de la configuración y de la lista de apps

### Responsabilidad
Un almacén JSON que «combina valores por defecto al leer + escribe de forma atómica»: `%APPDATA%\lanzadorapk\{settings.json,apps.json,icons/,apks/}`.

### Interfaz pública (`module.exports = store`)

| Miembro | Firma | Descripción |
|---|---|---|
| `DATA_DIR` / `ICON_DIR` / `APK_DIR` | `string` | 10-14; `DATA_DIR = %APPDATA%\lanzadorapk` |
| `getSettings()` | `() => Settings` | 175-186: `deepMerge(DEFAULT_SETTINGS, contenido en disco)` + **migración forzada** |
| `saveSettings(patch)` | `(patch) => Settings` | 188-196: `deepMerge(actual, patch)`; si existe `engine.resourceMode` se traduce a tres interruptores |
| `getApps()` | `() => App[]` | 198-201; con un archivo dañado vuelve a `[]` |
| `saveApps(apps)` | `(apps) => void` | 203-205 |
| `upsertApp(app)` | `(app) => app` | 207-214; combina por `package` |
| `removeApp(pkg)` / `getApp(pkg)` | | 216-223 |
| `iconPath(pkg)` / `apkPath(pkg,version='cur')` | `=> string` | 225-231 |
| `ensureDirs()` | `() => void` | 119-123 |
| `DEFAULT_SETTINGS` | objeto constante | 16-117; lo usan directamente las pruebas y doctor |

### Implementación clave

- **Escritura atómica** (133-138): escribe `<file>.tmp` → `renameSync`, para no dejar JSON a medias.
- **`deepMerge` (140-150)**: solo recorre objetos normales; arreglos y escalares se sobrescriben directamente; solo se recorre si `base[k]` es un objeto.
- **Migración al leer (175-186): tres sobrescrituras forzadas, sin campo de versión**:
  - `s.engine.headless = false` (179): el modo sin interfaz viejo ≠ no poder abrir ventanas;
  - `s.hideAfterLaunch = false` (181): en versiones viejas salir de la ventana contenedora mataba todo el runtime;
  - `s.freeform = false` (184): la ventana pequeña freeform vieja quedaba como «una ventanita dentro de la ventana».
  Como se sobrescribe en cada lectura, los `true` de un settings.json viejo dejan de valer para siempre (aserción en auto-test:455).
- **Traducción de la política de recursos (160-170, 191-193)**: `save`→`liteMode:true/priorityMode:balanced/renderSize:540x960`; `smooth`→`false/performance/720x1280`; `balanced`→`true/balanced/auto`. Solo se activa cuando aparece `patch.engine.resourceMode`, para no chocar con los interruptores individuales.
- **«Restricciones de hecho» en los valores por defecto** (están en los comentarios; no los borres al leer):
  - `engine.headless:false` (28-30): en modo sin interfaz SurfaceFlinger no da VSYNC; la app vive pero no hay imagen;
  - `engine.badGpu:''` (32-34): guarda `<versión de emulator>|<gpu>` de lo que «se cae al arrancar»; al actualizar el runtime deja de valer;
  - `runtime.dir:''` (68) = `%APPDATA%\lanzadorapk\runtime`;
  - `runtime.downloadConnections:8` (88);
  - `runtime.sourcePreference:'auto'` (91), `autoMirror:true` (94), `giteeToken:''` (97);
  - `runtime.compatImage:false` (78): **prácticamente obsoleto**; `provision.checkEnv:381-384` ya no depende de él y usa la imagen play también como principal;
  - `engine.logLimitKB:2048` (55), `engine.prefetch` no existe, `engine.prewarm:true` (65);
  - `display.portrait:'900x1600'` (112), pero `main.js:276` usa `d.portrait || '540x960'` (valores por defecto distintos; en la práctica manda el 900x1600 guardado en settings).
- **A `DEFAULT_SETTINGS` le falta `runtime.avdDir`**: `provision.paths():207` lee `runtime.avdDir`, que en instalaciones nuevas es `undefined`; solo existe cuando la interfaz lo escribe (`ui/app.js:1203`). Lo mismo con `runtime.installed`, que lee `engine.js:870` pero no está en los valores por defecto.

### Trampas e invariantes

- **`getSettings()` hace `readFileSync + JSON.parse` en cada llamada, sin caché en memoria** (175-186). Y `provision.paths()` lee settings 2~4 veces por llamada (193, 207, 209, etc.), y el sondeo de estado llama a `checkEnv()` desde varios sitios → lecturas frecuentes de un archivo pequeño. Si se quiere optimizar el rendimiento, este es el primer lugar.
- **`saveSettings` escribe «el objeto completo ya combinado»** (189-194), así que settings.json lleva todos los valores por defecto de ese momento; los nuevos valores por defecto que traiga una actualización no se escriben, solo se combinan al leer; justo por eso la migración puede hacerse al leer.
- La migración es **forzada en un solo sentido** (179-184); si en el futuro se quiere dejar que el usuario vuelva a activar headless, hay que cambiarlo aquí, no en la interfaz.
- El `renameSync` de `writeJson` falla entre volúmenes distintos (no pasa si `os.tmpdir` y `DATA_DIR` están en el mismo volumen; en las pruebas, tras cambiar `APPDATA`, siguen en el mismo).
- Forma de aislar las pruebas: cambiar `process.env.APPDATA` y **volver a hacer require** (`auto-test.js:11,1344-1347`); `DATA_DIR` es una constante que se evalúa al cargar el módulo y cambiar env en el mismo proceso no tiene efecto: tenlo en cuenta al escribir pruebas.

### Quién lo llama
- `src/core/provision.js:12,145,192,197-237,452,1159,1187,1193,1217`.
- `src/core/engine.js:15,1017-1021` (`store.DATA_DIR`), `src/core/emulator.js:16`, `src/core/installer.js:10`, `src/core/sharer.js:10`, `src/core/layers.js:162` (require diferido dentro de `summary`).
- `src/main.js`: todo el flujo (migración al iniciar, `app:info`, `settings:get/set`, `bootstrabBundledRuntime:97-171` hace `saveSettings({runtime:{dir}})` directamente).
- `test/engine-test.js:147`, `test/auto-test.js:456,700,1346,1374,1386`, `test/boot-test.js:21`.

### Cobertura de pruebas
- ✓ `auto-test.js:455` Migración forzada de configuraciones viejas: sin interfaz y «salir tras iniciar» ya no se aplican
- ✓ `auto-test.js:1373` La política de recursos se cambia en un solo lugar y se traduce sola a vCPU/prioridad/resolución
- ✓ `auto-test.js:1385` El tamaño de la partición de datos es configurable y por defecto ya no es un número fijo
- ✓ `engine-test.js:149` La carpeta del runtime por defecto está dentro de la carpeta de datos (depende de `DATA_DIR`)
- **Sin cobertura**: `upsertApp/removeApp/apkPath/iconPath`, la atomicidad de `writeJson`.

---

## 6. `src/core/layers.js` — inventario / recuperación de las capas del contenedor

### Responsabilidad
Trata la carpeta del runtime como capas de imagen para hacer un **inventario de solo lectura** y una **recuperación según una lista explícita** (`dryRun` por defecto), y da a la configuración un resumen de «cuánto disco ocupa en total».

### Interfaz pública (exporta `{analyze, prune, summary, walk, dirSize}`)

| Exportación | Firma | Descripción |
|---|---|---|
| `walk` | `(dir, out=[], depth=0) => [{path,size}]` | Lista recursiva de archivos, **profundidad máxima 6** (15-27) |
| `dirSize` | `(dir) => bytes` | 29 |
| `analyze` | `(root, {keepAvd='lanzadorapk.avd', aggressive=false, keepSnapshots=false}) => {total,groups,candidates}` | 36-127 |
| `prune` | `(root, {apply=false, keepAvd, aggressive, keepSnapshots, onRemove}) => {…analyze, apply, removed, saved, after}` | 133-152 |
| `summary` | `(root) => {total,totalText,runtimeText,groups,reclaimable,reclaimableText,count}` | 155-184 |

Elementos de `candidates[]`: `{path, size, reason, kind:'file'|'dir'}`.

### Implementación clave

**1) Las 8 clases de elementos recuperables de `analyze()` (en el orden del código)**

| # | Líneas | Objetivo | reason |
|---|---|---|---|
| 0 | 48-51 | `emulator/`, `system-images/`, `avd/`, `platform-tools/` | Solo agrupa tamaños (`groups`), no borra |
| 1 | 53-61 | `emulator/qemu/windows-x86_64/qemu-system-{aarch64,armel,i386}*` | Destinos QEMU que no son x86_64 |
| 2 | 63-68 | `system-images/**/{NOTICE.txt,source.properties}` de más de 1 MB | Archivos de texto grandes dentro del paquete de imagen |
| 3 | 70-77 | `system-images/android-30` (solo si existe el `system.img` play de API34), `<root>/x86_64` | Imagen vieja / carpeta descomprimida en un lugar equivocado |
| 4 | 79-86 | `avd/*.avd` con `name !== keepAvd` | AVD inactivos (con 8-16 GB de datos de usuario) |
| 5 | 87-90 | `avd/**/*.lock` | Archivos de bloqueo que quedaron de una salida anómala |
| 6 | 91-100 | `avd/<keepAvd>/snapshots` o `snapshots.stale-N` (con `keepSnapshots=false`) | Instantáneas quickboot viejas |
| 7 | 103-110 | `<root>/_tmp`, `<root>/images` | Temporales de descarga / restos de QEMU·ISO viejos |
| 8 | 112-123 | Con `aggressive`, `emulator/crashreport.exe` | Solo para compilar el paquete de distribución |

**2) Restricciones de seguridad de `prune()` (139-141)**
```js
const p = path.resolve(c.path), rootAbs = path.resolve(root);
if (p === rootAbs || !p.startsWith(rootAbs + path.sep)) continue;   // no sale de root ni borra root
```
Con `apply=false` **no toca ni un archivo** (142-149), solo devuelve la lista; si un borrado falla (archivo en uso) se omite en silencio y se limpia la próxima vez (148).

**3) `summary()` (155-184)**: `analyze` del runtime + 4 carpetas extra (`avd`, `APK_DIR`, `ICON_DIR`, `logs`), filtra grupos de 0 bytes y a partir de 1 GB pasa la unidad a GB.

### Trampas e invariantes

- **La lista negra de `aggressive` es una restricción dura** (comentario de 112-114): `Qt6WebEngineCoreAndroidEmu.dll` es una dependencia de carga de `qemu-system-x86_64.exe` y **nunca puede borrarse**; `qsn/netsim` se conservan por prudencia.
- **`keepAvd` está fijo por defecto en `'lanzadorapk.avd'`** y debe coincidir con `AVD_NAME` de `emulator.js`; al renombrar hay que cambiar los dos.
- **Con el runtime en marcha debe usarse `keepSnapshots:true`**: `engine.cleanup()` pasa `keepSnapshots: this.vmRunning` (`engine.js:1019-1023`); si no, borrar la instantánea de la sesión actual dañaría la máquina en ejecución.
- La profundidad 6 de `walk` evita ciclos de enlaces simbólicos/desbordar la pila con carpetas profundas; los archivos a más de 6 niveles no cuentan en el tamaño (se subestima).
- Los `candidates` de `analyze` **no incluyen** «userdata/instantáneas del AVD activo (con `keepSnapshots=true`)»; es la garantía de que «las apps instaladas no se borran» (aserción en auto-test:174).
- El `after` de `prune` es solo `total - saved`, sin volver a escanear; si un borrado falla de verdad no coincide del todo con la realidad.

### Quién lo llama
- `src/core/engine.js:1017` (`usage()` → `summary`), `:1019-1023` (`cleanup()` → `prune`).
- `src/main.js:1004` (`runtime:usage` → `runtime.usage()` → `summary`), `:1056-1071` (`runtime:cleanup`: primero `apply:false` para la lista → confirmación con `dialog.showMessageBox` → `apply:true`).
- `src/ui/app.js` (panel «Uso/Limpieza» de la configuración, vía `runtime:usage`/`runtime:cleanup`).
- `test/auto-test.js:25,157,167,171`.

### Cobertura de pruebas
- ✓ `auto-test.js:139` Inventario de lo recuperable: QEMU no x86_64, imágenes viejas, AVD viejos, archivos de bloqueo, instantáneas viejas (incluye que dryRun no borra y que tras `apply` se conservan el AVD activo y el QEMU x86_64)
- **Sin cobertura**: las 4 carpetas extra de `summary()`, la rama `aggressive`, el límite de profundidad.

---

## 7. Las cuatro utilidades

### 7.1 `src/core/logfile.js` — rotación de registros por tamaño

| Exportación | Firma | Descripción |
|---|---|---|
| `rotate` | `(file, limitKB) => bool` | 15-26: con `size < limit` devuelve false; si no, borra el `.1.log` viejo → `rename` a `.1.log` |
| `append` | `(file, line, limitKB=2048) => bool` | 33-45: hace rotate **la primera vez de cada proceso + cada 200 líneas** (39); `appendFileSync` agrega el salto de línea |
| `trimNow` | `(file, limitKB=2048) => bool` | 48-50: comprobación incondicional al iniciar |

- Responsabilidad: `app.log` / `emulator.log` con append continuo se llenarían (cabecera 2-9); solo se conserva **una** copia `.1.log`.
- Trampas: `limitKB` se limita con `Math.max(256, ...)` a ≥256 KB (39, 49); `counters` es un `Map` de nivel de módulo que vuelve a cero al reiniciar el proceso; `rotate` usa `renameSync`, que en Windows falla si el archivo está en uso y devuelve false (en silencio).
- Quién lo llama: `src/main.js:85` (`appLog`, `logs/app.log`), `src/core/emulator.js:577` (registro de emulator).
- Pruebas: ✓ `auto-test.js:1404` si el registro supera el límite se rota solo y se conserva una sola copia.

### 7.2 `src/core/notify.js` — notificaciones de Android → notificaciones de Windows

| Exportación | Firma | Descripción |
|---|---|---|
| `parseRecords` | `(texto de dumpsys) => [{pkg,key,title,text}]` | 34-63 |
| `NotifyBridge` | `new NotifyBridge({getClient,getAppLabel,getAppIcon,onOpen})` | `start()/stop()`, internamente `setInterval(_tick, POLL_MS=2500)` (11, 77-89) |

Implementación clave:
- Cada 2,5 s `client.shell('dumpsys notification --noredact', {timeout:12000})` (97), **primero `isOnline()`** (96);
- Filtro: lista `SYSTEM_PKGS` + `com.android.providers.*` + `launcher` (18-32); se omiten `FLAG_ONGOING_EVENT(0x2)` y `FLAG_FOREGROUND_SERVICE(0x40)` (43-45);
- El primer `_tick` solo fija la base `primed`, para no mostrar todas las notificaciones antiguas al iniciar (99-104); si `seen` pasa de 500 se recorta a 300 (113);
- Clic en `note.on('click')` → `onOpen(pkg)` (130);
- El módulo hace `require('electron')` en el nivel superior (9) → **no se puede probar en Node puro**; por eso `test/notify-test.js` se ejecuta con electron.

Quién lo llama: `src/main.js:36,682-697` (`startNotifier()`; solo lo arranca `onContainerActive(true)` cuando el contenedor tiene ventanas de app; al cerrar `:670-678` hace `stop()`; `:1772` stop al salir).
Pruebas: `test/notify-test.js` (llama a `parseRecords` con el volcado real `test/notif.txt`; **no está en `npm test`**); `NotifyBridge` no tiene cobertura.

### 7.3 `src/core/android.js` — interruptores de ajustes de Android (sin entrar al escritorio)

| Exportación | Descripción |
|---|---|
| `ACTIONS` | 11 constantes de acción `android.settings.*` (7-19) |
| `AndroidSettings` | `new AndroidSettings(runtime)`; métodos `status()`, `setWifi`, `setAirplane`, `setVolume`, `setAnimations`, `setFontScale`, `setDensity`, `tune({pkg})`, `open(action)`, `permissions(pkg)`, `grantAll(pkg)` |

Implementación clave:
- `client()` hace `await runtime.ensure()` cada vez (24-28); si falla lanza «el runtime no está listo»;
- `_sh(commands)` une varios comandos con `; ` en **un solo** `adb shell` (30-34), con 20 s de límite;
- `status()` obtiene 7 valores de una vez con `echo "k=$(...)"` y los analiza con regex (37-61);
- `tune()`: desactiva las tres animaciones + `max_cached_processes=32` + opcionalmente `deviceidle whitelist +pkg` (111-121);
- `permissions()` analiza la sección `runtime permissions:` de `dumpsys package` y la cierra por sangría (131-145); `grantAll()` hace `pm grant` uno por uno e ignora los fallos (147-156);
- Rangos: `fontScale 0.85~1.3`, `density 120~640`, `volume 0~100` (79-108).

Quién lo llama: `src/main.js:1501` (`androidSet = new AndroidSettings(runtime)`), `:1404-1434` (IPC `android:status/set/open/tune/permissions/grantAll`); `src/preload.js` lo expone a la configuración.
Pruebas: **✗ sin cobertura** (necesita adb real).

### 7.4 `src/core/display.js` — cálculos puros de adaptación de pantalla

| Exportación | Firma | Descripción |
|---|---|---|
| `densityFor` | `(w,h,manual) => dpi` | Con `manual>0` limita a 120~640; si no, `min(w,h)/2.57` limitado a 200~480 (7-10) |
| `portraitSize` | `(str) => {w,h}` | Analiza `900x1600`; si es inválido/horizontal devuelve `{900,1600}` (12-18) |
| `defaultBounds` | `(area) => {x,y,w,h}` | Alto `area.h*0.84`, ancho 9:16, centrado (20-28) |
| `fullscreenBounds` | `(portrait, area) => {x,y,w,h}` | Ocupa toda la altura, calcula el ancho con la proporción vertical y centra horizontalmente (36-46) |
| `sizeFor` | `(mode, portrait, area) => {w,h}` | **Los dos modos devuelven el preajuste vertical** (55-57) |

Invariante clave (en los comentarios): la proporción de la ventana del emulador **queda fijada por el LCD al arrancar**; un `SW_MAXIMIZE` directo solo da una ventana pegada a la izquierda con el mismo ancho; por eso «pantalla completa» = maximizar la ventana **sin cambiar la resolución de Android** (48-54), y cambiar de modo no requiere reiniciar el runtime.

Quién lo llama: `src/main.js:32` (require), `:274-277` (`portraitSize()` lee `display.portrait`): **solo `portraitSize` se usa en el código de ejecución**; `densityFor/defaultBounds/fullscreenBounds/sizeFor` hoy solo los llaman las pruebas (`appwin.js:46` tiene su propio `AppWindow.sizeFor`).
Pruebas: ✓ `auto-test.js:465` adaptación de pantalla: ventana y pantalla completa comparten la resolución vertical; la ventana 9:16 se puede estirar (cubre las 4 funciones).

---

## 8. Cadena completa de descarga / implementación / actualización

### 8.1 Diagrama de flujo en texto

```
[El usuario pulsa «Hacerlo todo»]
src/ui/app.js:371  deployAll()
   ├─ setStepBusy('all',true)  → texto del botón «Preparando…» (app.js:334)
   ├─ api.autoDeploy()         → preload.js:45  invoke('runtime:autoDeploy')
   └─ IPC runtime:autoDeploy   → main.js:870
        └─ autoDeploy()        → main.js:314  (con el cerrojo de exclusión deploying, main.js:313/315)

[Flujo principal de autoDeploy main.js:314-354]
 1. env = provisioner.checkEnv()                           main.js:319
 2. needEngine = !env.emulator.ok || !env.sysimg.ok        main.js:320
 3. if needEngine && settings.runtime.preferGithubRuntime:
      installRuntimePack(progress)                          provision.js:522
        ├─ resolveRuntimePack()                             provision.js:476
        │    ├─ ¿runtimePackUrl propio? se usa directamente                :477
        │    ├─ GET en paralelo de releases?per_page=15 de GitHub / Gitee  :487
        │    └─ busca en assets /^LanzadorAPK-runtime-.*\.zip$/ y toma el más alto con cmpVer  :497-515
        ├─ guardDisk('runtime', root)   [512+1024=1536MB]    :525 → :262
        ├─ sources.rank(sources.candidates(url))  medición en serie   :534-536 → sources.js:399
        ├─ downloadMulti(urls, _tmp/runtime-pack.zip)        :541 → download.js:338
        │    ├─ sondeo de Range en paralelo → solo mezcla fuentes con «el mismo tamaño total»   download.js:355-381
        │    ├─ bloques repartidos en rotación entre 8 hilos + archivo auxiliar .chunks.json     download.js:391-416
        │    └─ vigilante de inactividad 20 s / lentitud 45 s y <120 KB/s cambia de fuente      download.js:449-503
        ├─ control de tamaño <200 MB → lanza «descarga del paquete completo incompleta»            :556
        ├─ extractZip(zip, root)   >64 MB usa ZipFile en flujo     :559 → :591
        ├─ escribe <root>/.runtime-pack.json y borra el zip              :566-571
        └─ materializeImages()  .img.xz/.gz → .img           :573-576 → :722
      afterPack = checkEnv()                                 main.js:328
      if emulator.ok && sysimg.ok → return {ok:true,source:'github'}
      else → sigue completando con la fuente oficial (main.js:330)
 4. Respaldo componente a componente con la fuente oficial (solo si el paso anterior falló/quedó incompleto):
      installAdb()          provision.js:428  → downloadAny  platform-tools.zip
      installEmulator()     provision.js:905  → downloadAnyParallel + extractZip + ensurePlatformTools
      installSystemImage()  provision.js:966  → installPlayImage(:1004) → downloadAnyParallel + extractZip
 5. after = checkEnv(); ok = adb.ok && emulator.ok && sysimg.ok   main.js:347-348
 6. finally deploying=false                                 main.js:351-353

[La interfaz sigue con el arranque app.js:381-387]
 api.runtimeStart() → main.js:880 → runtime.ensure()        desde engine.js:787
   ├─ provisioner.materializeImages(onLog).catch(()=>{})     engine.js:848
   ├─ checkEnv()                                             engine.js:849
   ├─ killOrphanEmulators()                                  engine.js:856
   └─ boot()  si falla, diagnóstico de doctor + reintento con variantes (GPU/accel/memoria bajando por niveles)

[Las dos cadenas en segundo plano tras iniciar]
 A. Implementación automática (retraso de 20 s) main.js:1657-1661 → autoDeploy()   ← la misma función que la interfaz
 B. Comprobación de actualizaciones (en la versión empaquetada, retraso de 8 s) main.js:1665-1676
      updater.check()                     updater.js:73
        └─ sources.latest({force})        sources.js:277
             ├─ fetchReleases() en paralelo GitHub/Gitee            :237
             ├─ 403/429 → cortacircuitos de 15 min                          :286-290
             ├─ todas fallan → último resultado + stale                  :292-298
             └─ unión de recursos de la misma versión (urls[] + sizes{}), se conservan parts  :304-348
      info.hasUpdate → notify + send('update:state')

[El usuario pulsa «Actualizar ahora»]
 main.js:579 runUpdate()  (exclusión con updateBusy)
   ├─ updater.prepare(info)                              updater.js:121
   │    ├─ ¿parts?  _downloadParts()  cada parte mide+descarga+une en orden  :182
   │    └─ si no    candidates→rank→downloadMulti          :140-163
   │    └─ .zip → _extract a update/<ver>/payload         :166-173
   ├─ updater.apply(job)                                  updater.js:258
   │    ├─ genera el script PS (Wait-Process 90 s → copiar/instalar en silencio → reiniciar → limpiar → exit 0)
   │    ├─ lo guarda en update/apply.log.ps1 (para diagnosticar)               :310
   │    └─ spawn powershell -EncodedCommand (**no detached**) + unref  :319-323
   └─ setTimeout(900ms) → quitting=true; app.quit()        main.js:596
        └─ el script espera a que salga el proceso → sobrescribe la carpeta de instalación → Start-Process exe → borra update/<ver>
```

Cifras de tiempo clave (todas son constantes únicas; quien tome el proyecto no debería bajarlas a la ligera):
- Retraso de `autoDeploy` **20 s** (`main.js:1661`; comentario: durante el arranque en frío el disco/CPU ya van al máximo);
- Retraso de la comprobación de actualizaciones **8 s** y solo con `app.isPackaged` (`main.js:1665-1675`);
- En `apply`: `Wait-Process -Timeout 90`, copia en **12 rondas ×600 ms**, limpieza 400 ms tras reiniciar (`updater.js:271-306`);
- Tras volver `apply`, la app sale a los **900 ms** (`main.js:596`);
- `downloadMulti`: inactividad por bloque **20 s**, umbral de lentitud **45 s + 120 KB/s**, **6** reintentos por bloque, como máximo **2** cambios de fuente;
- `download` (una conexión): inactividad **30 s**, **2** reintentos ×1,5 s si no es 2xx.

### 8.2 Los puntos de esta cadena que más fallan

| # | Síntoma (visto por el usuario) | Ubicación en el código | Mecanismo / notas |
|---|---|---|---|
| 1 | **«Atascado preparando el runtime»**, la barra de progreso se queda mucho tiempo en 1~3 % | `provision.js:531` (`percent:1` fijo) + `sources.js:412-417` (medición **en serie**, ≤9 s por dirección) + `sources.js:52` (256 KB por vez) | 4 candidatas (directa + 2 espejos + Gitee) son más de 30 s «sin ningún progreso en bytes». Cuanto peor la red, más candidatas y más parece colgado |
| 2 | El progreso **se queda mucho en 99 %** y luego vuelve a «completar con la fuente oficial» | `provision.js:575-576` (`materializeImages(...).catch(()=>0)`) + `:790` (un fallo de imagen solo hace onLog) | El fallo al descomprimir `.xz` se lo tragan dos catch → `checkEnv().sysimg.ok=false` → `autoDeploy` va por `main.js:330` y baja otros 1,4 GB; en el siguiente inicio vuelve a intentar descomprimir |
| 3 | Errores raros relacionados con `@napi-rs/lzma` | `provision.js:771-781` (`require.resolve('@napi-rs/lzma')` y luego require de `index.js` por ruta de archivo) | Si al empaquetar no se incluyó el binario de lzma/quedó dentro de asar → `Cannot find module`; el comentario explica por qué no se puede hacer `require('@napi-rs/lzma')` directamente (polyfill ESM) |
| 4 | **«Configuré la carpeta del runtime y sigue descargando a AppData»** | `provision.js:217-224` (tres ramas de `sysImgRoot`), `:726` (destino de `materializeImages`), `:237` (`avdHome`), `store.js:67-98` (`runtime.dir` vacío por defecto), `main.js:97-171` (`bootstrapBundledRuntime` **sobrescribe** `runtime.dir`) | ① Si ya existe `<DATA_DIR>/system-images` de un usuario viejo → la rama 2 la sigue usando y no la mueve; ② si junto al exe portátil hay `runtime/`, `bootstrapBundledRuntime` hace `saveSettings({runtime:{dir: bundled}})` en `main.js:165-168` y sobrescribe la carpeta elegida por el usuario (solo respeta la configuración vieja con `sameTree && existe emulator.exe`, `:144-148`); ③ el AVD tiene su propia opción `avdDir`, que puede estar en otro disco que el runtime |
| 5 | Hay disco de sobra pero dice «espacio insuficiente», o al revés falla a mitad de la descompresión | `provision.js:262-277` (la tabla `need` de 264-265 no tiene `'runtime'`), `main.js:940` (umbral de autocomprobación 8192 MB) | `guardDisk('runtime')` solo estima 1536 MB, cuando paquete + descompresión necesitan ~5 GB; tras pasar la guardia aún puede llenarse el disco |
| 6 | El progreso **se queda en 95 %** (issue histórica) | Ya hay remedio: `download.js:446-451,492-503` (cambio de fuente por lentitud), `:466-480` (resolución garantizada); la ruta de una conexión aún solo tiene `idleMs=30s` (`:112`) | Bloques finales de una fuente lenta; el archivo auxiliar (`.chunks.json`) hace que el reintento solo complete los bloques que faltan, sin volver a bajar todo |
| 7 | Tras «conexión interrumpida / detenida» se pierde toda la descarga | `download.js:155` (`close` con `!complete` → reject), `:526-528` (bloque sin reintentos → lanza + guarda auxiliar) | Por diseño se puede reanudar; pero `downloadParallel` degrada a una conexión al ver un archivo a medias (`:188-191`) y los varios hilos pasan a uno solo |
| 8 | La actualización se queda en «Reemplazando el programa y reiniciando» | `updater.js:315-323` (comentario de compatibilidad: **no puede ser detached**), `:271` (Wait-Process 90 s), `:280-285` (copia en 12 rondas) | Un programa de seguridad bloquea el «proceso separado» → el script no se ejecuta; o UAC bloquea la desinstalación/instalación; `update/update.log` es la única evidencia |
| 9 | Tras actualizar aparece un archivo raro de 1,5 GB en la carpeta del programa | `updater.js:80` (respaldo portátil `/\.zip$/i`) | Si una versión solo tiene `LanzadorAPK-runtime-vX.zip` y ningún recurso `portable`, se descomprime en la carpeta de instalación como si fuera la actualización |
| 10 | En Gitee «hay una versión sin instalador» | `.github/workflows/release.yml:36-44,78-100` (control de 100 MiB + falla directamente si falta `GITEE_TOKEN`); lado consumidor `sources.js:172-204`, `updater.js:182-227` | Es un problema de compilación, pero el síntoma aparece aquí; las partes deben ser `part1..N` consecutivas o se descarta todo el grupo (`sources.js:196-203`) |
| 11 | Tras cambiar de fuente / prefijo de espejo sigue usando la dirección vieja | `main.js:819-825` solo hace `sources.reset()`; los `_cache.*` de `provision.js:479,514,642,664,984` no tienen forma de invalidarse | Hay que reiniciar el proceso para que tenga efecto del todo |
| 12 | El sondeo de estado satura la CPU/lanza muchos procesos | `provision.js:687-714` (los fallos de `emulatorVersion` no se guardan en caché), `:298-315` (caché de adb de 30 s), `:845-902` (accel 30 s + disco 6 h/10 min) | Sin emulator instalado, cada `checkEnv` hace `execFile` probando varias rutas |
| 13 | El AVD figura como «ya en uso» y no arranca | `layers.js:87-90` (lista de archivos de bloqueo), `main.js:963-969` (la autocomprobación encuentra `.lock`), `engine.js:856` (`killOrphanEmulators`) | Quedaron `*.lock` de una salida anómala; el panel de limpieza los recupera |
| 14 | En el primer inicio se pierden «las apps instaladas/los datos» | `store.js:179-184` (tres migraciones forzadas), `engine.js:848` (`materializeImages`), `doctor.snapshotKey`/`imageIdentity` (huella de la instantánea, `auto-test.js:88,98`) | La migración es en un solo sentido; la huella de la instantánea **no incluye el tamaño de la partición de datos** (`auto-test:1395`), así que ampliar no borra datos |

### 8.3 Tres «mira aquí primero» para quien toma el proyecto

1. **Una sola función explica el 80 % de los problemas de implementación**: `Provisioner.checkEnv()` (`provision.js:367`). Decide a la vez «qué falta» en la interfaz, la rama de `autoDeploy`, si `engine.ensure()` usa emulator o qemu y el contenido del informe de diagnóstico.
2. **Las reglas de rutas están en un solo lugar**: `Provisioner.paths()` (`provision.js:197`). Todo código nuevo que guarde archivos del runtime debe tomar las rutas de ahí, sin armar `DATA_DIR` por su cuenta.
3. **Las estrategias de descarga están reunidas en `Sources` + `downloadMulti`**: una fuente nueva solo tiene que entrar en `candidates()`; la lógica nueva de «límite/elección» solo requiere cambiar `rank()` y las condiciones de mezcla de `downloadMulti`; no escribas otra en `provision.js`.
