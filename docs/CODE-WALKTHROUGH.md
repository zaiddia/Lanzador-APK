# Recorrido por el código de LanzadorAPK (para quien toma el desarrollo) — documento histórico de v0.3.5

> Para ingenieros que «van a seguir escribiendo código en este proyecto». No repite el README; responde tres preguntas:
> **en qué capas se divide el código, qué cadena recorre de verdad cada acción clave y dónde es más fácil tropezar al cambiar algo**.
>
> Generado: 2026-11-14 · versión **v0.3.5** (desarrollo continuado sobre v0.3.4, commit `e1db34b`) · repositorio `zaiddia/Lanzador-APK`
> Base del recorrido: `src/**` con 41 archivos, unas 14.845 líneas (js/html/css/ps1), `npm test` = **70 correctas / 0 fallidas**.
>
> **Cómo leer esta documentación**
> - Lee primero este documento (panorama + cadenas de llamadas clave + mapa de problemas, unas 360 líneas);
> - Para cambiar «instalación / análisis / iconos / accesos directos» → `CODE-WALKTHROUGH-PARSE.md`;
> - Para cambiar «descarga / implementación / cambio de fuente / actualización en línea / reglas de rutas» → `CODE-WALKTHROUGH-RUNTIME.md`;
> - Para cambiar «arranque / incrustación de ventanas / botones del ratón» → secciones 2.3~2.6 de este documento + `docs/ARCHITECTURE.md`.

---

## 0. Resumen en una página

| Pregunta | Respuesta |
|---|---|
| Qué es | Un «ejecutor de apps Android» para Windows: contenedor Electron + runtime Android propio (Google Android Emulator / virtualización completa con QEMU); cada app Android se instala como icono del escritorio y se abre en su propia ventana de Windows |
| Arquitectura en una frase | **El proceso principal de Electron orquesta, `core/*` aporta las capacidades de dominio, el agente de ventanas de PowerShell hace el trabajo sucio de Win32 y la capa de renderizado solo hace la interfaz** |
| Lo que no hace | No escribe su propio hipervisor, no hace traducción de núcleo Linux/GPU, no monta NTFS (la carpeta compartida usa sincronización), no depende de emuladores de terceros |
| Dependencias clave | Análisis escrito a mano sin dependencias de terceros en ejecución (zip/AXML/ARSC/PNG/ICO); solo `@napi-rs/lzma` (descomprime imágenes .xz) + Electron |
| Dónde están los datos | Datos `%APPDATA%\lanzadorapk` (settings.json / apps.json / icons / apks / logs), runtime `runtime.dir` (se puede cambiar de disco), AVD `runtime.avdDir` (se puede cambiar de disco) |
| De dónde sale la versión | `package.json:version`, que lee `app.getVersion()`; el CI publica al empujar un tag `v*` |

---

## 1. Estructura del repositorio

```
lanzadorapk/
├─ src/
│  ├─ main.js                1790 líneas  Proceso principal de Electron: ventanas/bandeja/instancia única/CLI/IPC/ciclo de vida
│  ├─ preload.js              130 líneas  Puente seguro contextBridge (única entrada de la capa de renderizado)
│  ├─ ui/                            Capa de renderizado (HTML/CSS/JS nativos, sin framework)
│  │  ├─ index.html / app.js         Interfaz principal (lista de apps + diálogo de configuración), app.js 1490 líneas
│  │  ├─ shell.html / shell.js/css   Contenedor de la ventana de la app (barra de título de 38px + capa de inicio)
│  │  └─ assets/                     logo / appicon.ico / código QR
│  └─ core/                          Capa de dominio (Node puro en lo posible, sin depender de Electron)
│     ├─ orquestación  installer.js engine.js container.js
│     ├─ runtime   emulator.js provision.js userdata.js doctor.js layers.js
│     ├─ dispositivo  adb.js android.js sharer.js notify.js display.js
│     ├─ ventanas  appwin.js agent.js win/agent.ps1 win/priority.ps1 windowctl.js pointer.js
│     ├─ análisis  zip.js axml.js arsc.js apk.js png.js shortcut.js assoc.js
│     └─ descarga/actualización download.js sources.js updater.js store.js logfile.js
├─ build/                    Cadena de empaquetado (pack.js / prepare-runtime.js / slim-runtime.js / zip.js / seed/)
├─ test/                     run-tests.js(8) + engine-test.js(11) + auto-test.js(53) + varios scripts de sondeo en equipo real
├─ tools/                    Scripts de publicación y de comprobación en equipo real (publish-gitee.js, check-*.js, e2e-boot.js)
├─ docs/                     ARCHITECTURE.md, images/, promo/, este documento
├─ engine/                   Caché de descarga del runtime (en gitignore, solo README)
└─ .github/workflows/        ci.yml (pruebas con dos versiones de Node), release.yml (portátil + completa + sincronización con Gitee)
```

**Dirección de llamadas entre capas** (solo las capas superiores dependen de las inferiores):

```
ui/*  ──preload(contextBridge)──▶  main.js
main.js ──▶ installer.js / engine.js / appwin.js / updater.js / sharer.js …
installer.js ──▶ apk.js ──▶ zip.js / axml.js / arsc.js / png.js / shortcut.js
engine.js ──▶ emulator.js ──▶ provision.js (guardia de rutas/disco) + userdata.js (ext4) + adb.js
appwin.js ──▶ agent.js ──TCP JSON──▶ win/agent.ps1(C# P/Invoke)
Todas las capas ──▶ store.js (persistencia de configuración/listas)
```

---

## 2. Cadenas de llamadas clave (léelas antes de cambiar código)

### 2.1 Doble clic en un APK → instalado y con icono en el escritorio

```
Doble clic en .apk desde el Explorador
 → HKCU\Software\Classes\LanzadorAPK.apk (registrado por assoc.js, sin administrador)
 → LanzadorAPK.exe "C:\x\a.apk"
 → main.js parseArgs() → runInstall(filePath)              main.js:537
     ├ Antirreentrada: installBusy (varios clics/arrastres solo ejecutan una vez)           main.js:540
     ├ installer.install()                                 installer.js:141
     │   ├ /\.(apks|xapk)$/ → parseBundle() (extrae las partes a una carpeta temporal) installer.js:26
     │   ├ parseApk()  →  zip.js → axml.js → arsc.js        apk.js:75
     │   ├ isArmOnly(meta) && sin imagen Play →
     │   │     ensureCompatImage() + switchToCompat()        installer.js:159
     │   └ runtime.ensure()  → ver 2.3
     ├ installer.finishInstall()                            installer.js:179
     │   ├ emulator.invalidateSnapshot() (tras instalar se invalida la instantánea vieja)
     │   ├ adb install -r -g -t (si falla con NO_MATCHING_ABIS reintenta con la imagen compatible)
     │   ├ icono a disco como PNG + iconToIco() (WebP lo decodifica el proceso de renderizado) main.js:213 decodeIcon
     │   ├ copia del APK en apks/ (para reinstalar solo más adelante)
     │   ├ resolveLauncher(): manda el LAUNCHER que resuelve el sistema    adb.js
     │   ├ store.upsertApp()
     │   └ createShortcut(): dos .lnk, escritorio + menú Inicio        installer.js:286
     └ notificación / actualizar la caché de iconos del Explorador
```

**Por qué `resolveLauncher` debe ejecutarse tras instalar**: la «Activity principal» que se obtiene del APK muchas veces no es el LAUNCHER real (en una app de video corto era `SplashActivity` y no `MainFragmentActivity`); usar la entrada equivocada se salta la inicialización → se cierra a los 3~8 s. Ver `docs/ARCHITECTURE.md`.

### 2.2 Doble clic en el icono del escritorio → aparece la ventana de la app

```
<nombre de la app>.lnk → LanzadorAPK.exe --launch <pkg> (shortcut.js escribe el lnk, con AppUserModelId)
 → main.js parseArgs() solo acepta la forma com.foo.bar              main.js:201
 → ¿ya hay instancia? second-instance → runLaunch()                 main.js:1477
 → runLaunch(pkg)                                          main.js:606
     ├ openAppWindow(): abre al momento una ventana con solo barra de título + capa de inicio main.js:286
     ├ armAgent(): primero envía el scope al agente de ventanas y activa la «supresión permanente»  main.js:1547
     ├ installer.launch()                                  installer.js:385
     │   ├ runtime.ensure() (ver 2.3)
     │   ├ beforeStart → prepareForeground() (inmersivo/sin animaciones/quitar bloqueo de pantalla)
     │   ├ ¿la app no está en el runtime actual? se reinstala sola desde la copia del APK        installer.js:404
     │   ├ grantRuntimePermissions()
     │   └ startApp() + staysAlive() (ventana de 25 s / 4 s seguidos vivo)
     │        3 reintentos si falla → pm clear + permisos → un intento más
     │        caída con evidence(APP_CRASHED) → pasa sola a la imagen compatible y repite
     ├ appWin.embed(): SetParent incrusta la ventana del emulador        appwin.js:213
     └ runtime.beginApp(pkg): detiene las demás apps, sube la prioridad, activa sincronización/notificaciones  engine.js:901
```

**Incrustar no es «proyectar» la imagen**: se hace `SetParent` de la subventana Qt del emulador a la ventana anfitriona de Electron y luego `SetWindowPos` según el rectángulo del área cliente. Por eso:
- La imagen se renderiza de forma nativa, a 60 fps nativos, y ratón y teclado van directo al invitado;
- Hay que llamar a `app.disableHardwareAcceleration()`; si no, las capas DirectComposition de Chromium tapan la subventana (`main.js:72`);
- Al cerrar la ventana hay que **aparcar primero (SetParent(NULL)+SW_HIDE) y luego destruir la anfitriona**; si no, Windows vuelve a colgar la subventana del escritorio (`appwin.js:318` / `agent.ps1:990`).

### 2.3 `runtime.ensure()`: qué hace exactamente un arranque

`engine.js:796 _ensureInner()` prueba en orden y **devuelve en cuanto un paso funciona**:

1. `client.isOnline()` → ya hay un dispositivo en línea: se reutiliza directamente con `prepare()`;
2. `adoptExisting()` (`engine.js:708`) → busca puertos de emuladores aún vivos (`tasklist` + `netstat` encuentran el puerto de escucha de qemu, sin adivinar 5554); tras `adb kill-server` hace `connect` + `getprop sys.boot_completed` uno por uno y reutiliza el que se pueda tomar;
3. Ya hay un `emulator-NNNN` en `adb devices` → se reutiliza;
4. El proceso existe pero el dispositivo está fuera de línea → `emulator.stop()` y se empieza de nuevo;
5. Ruta única (desde 0.5.6 no hay bases de terceros ni modo attach):
   - `provisioner.materializeImages()` descomprime las imágenes del sistema `.xz/.gz` (si ya están descomprimidas, pasa al instante);
   - `checkEnv()` comprueba si están adb/emulator/sysimg;
   - `killOrphanEmulators()` limpia los qemu que quedaron (si no, el bloqueo del AVD da FATAL);
   - `bootEmulator()` → `emulator.start()` (ver 2.4) → si funciona, `prepare()` (ensureFreeform + vigilante) → a los 20 s en reposo guarda la instantánea.

La capa exterior de `ensure()` es una **Promise idempotente** (`engine.js:787`): si el precalentamiento y el clic del usuario ocurren a la vez solo arranca una máquina, sin pelear por el bloqueo del AVD.

### 2.4 `emulator.start()`: el bucle de arranque con degradación automática

El núcleo de `emulator.js` es «`doctor.planVariants()` genera hasta 4 conjuntos de parámetros → se prueban uno a uno → cada uno se evalúa con probe → si el proceso cae o hay un registro fatal se pasa al siguiente»:

- Los parámetros los deduce `doctor.chooseProfile()` (memoria/núcleos/LCD/GPU/partición data/puertos); `liteMode` reduce las vCPU a 1/4 de los núcleos físicos (2~3);
- `gpuMode=auto` elige el backend según la versión de emulator (37.x usa `host`, las viejas `swiftshader_indirect`), con `software` como último recurso;
- `badGpu` recuerda el backend que «se cayó al arrancar la última vez» (la clave incluye la versión de emulator, así al actualizar deja de valer);
- Cada ronda de probe envía **un solo** comando adb (`getprop sys.boot_completed; pm path android`); tras 6 errores seguidos se autocorrige con `resetAdbServer()`;
- **La partición `/data` la crea el propio LanzadorAPK** (`userdata.js` + `ensureDataPartition()`, `emulator.js:348`): el `userdata.img` de la imagen oficial es solo un relleno de 1 MB en ceros; lanzar `emulator.exe` directamente se salta el formateo → el invitado cae en un bucle de reinicios de recovery. Por eso el primer arranque escribe a mano un ext4 con bloques de 4 KB (con `FILETYPE|ENCRYPT`, `ext_attr`) y luego lo amplía al tamaño configurado con el `qemu-img resize` + `resize2fs` incluidos.

### 2.5 Reglas de almacenamiento/rutas (aquí están todas las issues sobre cambiar de disco)

| Concepto | Ubicación en el código | Por defecto | Se puede cambiar de disco |
|---|---|---|---|
| Carpeta de datos `DATA_DIR` | `store.js:10` | `%APPDATA%\lanzadorapk` | No (si C: va justo de espacio, `relocateUserDataIfCrowded()` mueve la caché al disco del AVD, `main.js:50`) |
| Raíz del runtime `paths().root` | `provision.js` | `DATA_DIR\runtime` | Sí: `runtime.dir` |
| Carpeta del AVD `paths().avdHome` | `provision.js` | `DATA_DIR\avd` | Sí: `runtime.avdDir` |
| Carpeta de imágenes descomprimidas `paths().sysImgRoot` | `provision.js` | `DATA_DIR\system-images` | Sigue a la raíz del runtime (**debe usar la misma regla que el destRoot de `materializeImages`**; por esto llegó a haber dos copias en C:) |
| Carpeta compartida | `store.js:99` | `%USERPROFILE%\LanzadorAPKShared` | Sí: `sharedDir` |

### 2.6 El agente de ventanas (`agent.ps1`): por qué existe

El `windowsHide` de Node no controla las ventanas de consola de `qemu` / `netsimd` que emulator lanza de forma independiente (pertenecen a `conhost.exe` y el pid no coincide). Por eso hay un **proceso PowerShell residente** con C# + P/Invoke incrustados, que recibe órdenes por TCP local, un JSON por línea:

| Comando | Función |
|---|---|
| `scope {dirs, pid}` | Declara «qué carpetas tienen procesos que cuentan como nuestros» + el pid del proceso principal. **Sin scope no toca ninguna ventana** |
| `embed {host,x,y,w,h}` | `SetParent` + `SetWindowPos` para incrustar en la ventana anfitriona; si el pid anfitrión no es el proceso principal se rechaza (`host-not-ours`) |
| `fit` | Recoloca la subventana cuando la anfitriona se redimensiona/mueve |
| `park` | La quita y la esconde (hay que hacerlo antes de destruir la anfitriona) |
| `boothide on/off` | Supresión permanente: aplica periódicamente `ShowWindow(0)` a la ventana principal/barra de herramientas/consolas negras del emulador, saltándose la ya incrustada |
| `hook on/off {right,wheel,side}` | Gancho global del ratón (clic derecho atrás / unión de la rueda / botones laterales), **solo con la ventana de la app en primer plano; se quita al perder el foco** |
| `rotate` / `hide` / `show` / `probe` / `windows` / `consoles` / `quit` | Los demás |

**La lección clave de v0.3.4: el nombre de clase no es identidad; la ruta del proceso sí.** La versión vieja reconocía las ventanas por `QWindowIcon`, y WeChat 4.x es Qt6 con el mismo nombre de clase → «al abrir LanzadorAPK desaparece la ventana de WeChat». Ahora toda decisión pasa primero por `IsOurs(pid)` (`agent.ps1:168`); las consolas negras se reconocen por la cadena de procesos padre de conhost + un título que contiene una carpeta del scope (`agent.ps1:219`).

---

## 3. Responsabilidades de cada capa e interfaces clave

### 3.1 `main.js` (orquestación en el proceso principal)

| Bloque | Líneas | Descripción |
|---|---|---|
| Decisiones previas al inicio | 40-72 | `relocateUserDataIfCrowded()` (mueve la caché si C: va justo), `disableHardwareAcceleration()` |
| Toma automática de la versión completa | 97-171 | Si junto al exe hay `runtime/` + alguna imagen completa → escribe solo `runtime.dir` y activa el modo compatible; exige `sameTree` (solo bajo el árbol del EXE actual), para que una versión portátil movida no siga usando el paquete viejo |
| Instancia única + parámetros | 196-209, 1473-1482 | `--launch <pkg>` / `<path.apk>` / `--autostart`; second-instance se reparte a la instancia en ejecución |
| Bandeja | 468-530 | Acceso directo a las primeras 8 apps, pantalla completa, recrear accesos directos, buscar actualizaciones, salir |
| Instalación | 537-573 | `runInstall()`: antirreentrada + los errores solo muestran una notificación del sistema |
| Inicio | 606-662 | `runLaunch()`: ver 2.2 |
| Actualización | 579-604 | `runUpdate()`: `updater.prepare()` → `apply()` → salir para que el script tome el control |
| IPC | 702-1469 | Unos 120 canales, agrupados por dominio (apps/apk/settings/display/runtime/provision/doctor/android/update/window/shell) |
| Ciclo de vida | 1484-1790 | En `whenReady` se arman todos los objetos; `before-quit` sale en dos fases (primero aparca las ventanas y luego sale de verdad) |

**Convención de nombres de IPC**: `dominio:acción`; la capa de renderizado solo puede llamar a través de `window.lanzadorapk.*` que expone `preload.js`, y los eventos enviados están en una lista permitida (`preload.js:120`).

### 3.2 `core/engine.js` (ciclo de vida del runtime)

Exporta `class Runtime`: `ensure / prewarm / boot / stop / adoptExisting / beginApp / endApp / status / diagnostics / cleanup / dispose`.
Invariantes clave:

- `ensure()` y `prewarm()` son Promises idempotentes;
- `dispose()` **nunca mata qemu a la fuerza** (cortaría la instantánea quickboot que se está escribiendo → la próxima vez solo hay arranque en frío);
- Las instancias tomadas no tienen identificador proc local; `vmRunning` debe mirar también `adb isOnline()`, si no, el vigilante nunca las libera;
- El vigilante de reposo da una vuelta cada 60 s: solo detiene cuando vence `idleShutdownMinutes` y no hay apps activas.

### 3.3 `core/emulator.js` (adaptación del emulador)

Responsabilidades: creación del AVD / generación de parámetros / lanzamiento del proceso / probe / instantáneas / prioridad / puertos / limpieza de huérfanos / partición de datos. Interfaz: `start/stop/running/scheduleSnapshotSave/saveSnapshotNow/cancelSnapshotSave/invalidateSnapshot/ensureDataPartition/resizeDataPartition/dataInfo/setPriority/killOrphanProcesses/resetAdbServer/versions`.
Las trampas están reunidas en el comentario de cabecera (`emulator.js:330-347`): el tamaño de bloque debe ser 4096, el bit `encrypt` debe ponerse al final, `ram.bin` vs `ram.img`, `emulator.exe` es solo un lanzador.

### 3.4 `core/adb.js` (operaciones del dispositivo)

`class AdbClient`: `isOnline/shell/exec/install/installMultiple/uninstall/startApp/forceStop/clearData/runningPackages/wmSize/setOrientation/keyBack/keyForward/input/prepareForeground/grantRuntimePermissions/dismissPermissionDialog/resolveLauncher/ensureFreeform/devices/connect/killServer`.
Clave para el rendimiento: el **canal de entrada `adb shell` residente** (`input()` usa `echo __LANZADORAPK_<id>__` como respuesta/contrapresión); el clic derecho atrás y la rueda ya no lanzan un proceso adb por cada paso.

### 3.5 `core/installer.js`

Ver 2.1. Merece la pena recordar dos rutas de «reparación automática»: `switchToCompat()` (tras cambiar de imagen reinstala las apps desde las copias de APK) y `ensureShortcuts()` (al iniciar completa los iconos/accesos directos que las versiones viejas no crearon).

### 3.6 `src/ui/`

- `app.js`: máquina de estados en un solo archivo (objeto `state` + varias funciones render), sin framework; todas las llamadas al backend hacen `await window.lanzadorapk.xxx()`;
- Progreso de instalación: toast fijo en `installFiles()` + evento `install:progress`; **al fallar primero `off()` y luego `dismiss()`** (de ahí venía el viejo «mensaje de error en bucle»);
- `shell.html/js`: contenedor de la ventana de la app, solo con los botones rotar/minimizar/maximizar/cerrar + capa de inicio.

### 3.7 Persistencia `core/store.js`

`getSettings()` hace siempre `deepMerge(DEFAULT_SETTINGS, valor en disco)` y **fuerza la migración** de tres opciones históricas (`headless=false` / `hideAfterLaunch=false` / `freeform=false`);
`saveSettings()` escribe tmp + rename (escritura atómica) y traduce `resourceMode` → `liteMode/priorityMode/renderSize`.
`apps.json` es `{ apps: [...] }`, y `upsertApp` combina por `package`.

---

## 4. Cadena de compilación / publicación

| Comando | Script | Resultado |
|---|---|---|
| `npm run pack` | `build/pack.js` | `dist/LanzadorAPK-win64-portable/` (~226 MB descomprimido; el runtime se descarga en el primer inicio) |
| `node build/zip.js <dir> <zip>` | `build/zip.js` | Comprime con 7-Zip `-mx=9` + se autoverifica con el analizador zip propio; **si supera 100 MiB falla** (límite por archivo) |
| `npm run runtime` | `build/prepare-runtime.js` | `build/runtime/` (emulator reducido + imágenes xz/gz + `build/seed/userdata.img.gz`) |
| `npm run build:exe` | los dos pasos anteriores + `electron-builder --win nsis` | `dist/release/LanzadorAPK-<ver>-Setup.exe` (~1,32 GB, runtime incluido) |
| `npm test` | `run-tests.js` + `engine-test.js` + `auto-test.js` | 70 pruebas en Node puro |
| `npm run test:boot` | `test/boot-test.js` | Arranque real de un invitado Alpine; verifica parámetros de QEMU/creación de disco/apagado ordenado |
| `npm run selftest` | `scripts/selftest.js` | Validación de extremo a extremo en un dispositivo instalado (adb/versión/freeform/carpeta compartida; `--apk` recorre instalar→iniciar→captura) |

`.github/workflows/ci.yml`: Windows × Node 20/22 ejecuta `npm test` + `test/pointer-hook-logic.ps1` (para que no se rompan los botones del ratón).
`.github/workflows/release.yml`: tag `v*` → job `build` (zip portátil → GitHub Release → sincronización con Gitee; si falta `GITEE_TOKEN` falla en vez de omitirse en silencio) + job `full` (ensamblar runtime → xz → Setup NSIS → subir al Release + zip del paquete completo del runtime).

**Lista de comprobación de publicación** (resumen de tropiezos pasados):
1. Hay que subir la versión de `package.json` (si no, el cliente dice «ya está actualizado»);
2. Si existe `.github/release-notes-<tag>.md` se usa; si no, `--generate-notes`;
3. El job `full` tarda ~40 minutos (compresión xz de 1,1 GB);
4. Para Gitee se usa `tools/publish-gitee.js`: primero el paquete entero, y solo se divide si supera el límite;
5. Tras publicar, comprobar que «paquete publicado == código»: mirar si `agent.ps1` dentro del zip tiene `SetScope`/`IsOurs` y la versión de `package.json`.

---

## 5. Pruebas y herramientas de verificación en equipo real

- **Regresión en Node puro** (siempre en CI): `test/auto-test.js` cubre la matriz de parámetros de doctor, la máquina de estados del contenedor, el descargador/fuentes, la lógica de pointer, la rotación de registros, etc.;
- **Sondas en equipo real** (se ejecutan a mano en el equipo, no en el entorno aislado): `tools/check-windows.js` (fugas de ventanas al arrancar), `check-console.js` (ventanas negras), `check-launch-clean.js` (instalar+abrir+incrustar), `check-quit-clean.js` (restos al salir), `check-update.js` (API real de GitHub), `e2e-boot.js` (tiempos de arranque en frío/caliente);
- **Prueba rápida de la interfaz**: `electron . --smoke out.png`, con `--settings` / `--perf` / `--download` para capturar cada sección de la configuración;
- **Pruebas de lógica PS**: `test/pointer-hook-logic.ps1` maneja por reflexión el callback del gancho; `agent-compile.ps1` solo verifica que el C# compila.

> Entorno real de este equipo (la máquina de desarrollo): **Node 22.22.2 / npm (`.workbuddy/binaries/node`)**, **PortableGit 2.55**, Electron 33.4.11 (`node_modules/electron/dist`), runtime `D:\LanzadorAPKRuntime` (emulator 37.3.9.0 + AEHD Operational), AVD `D:\LanzadorAPKData`, datos `%APPDATA%\lanzadorapk`.

---

## 6. Mapa de problemas actual (lo primero que conviene mirar al tomar el proyecto)

### 6.1 Errores conocidos más frecuentes (con su issue de GitHub)

| Issue | Síntoma | Ubicación del código identificada |
|---|---|---|
| #21 instalar 2 GB+ se queda colgado | Un APK grande da error y «el círculo de abajo a la derecha gira sin parar» | `apk.js:78` `fs.readFileSync(filePath)` lee el paquete entero y choca con el límite de un Buffer de Node; debería usar el `ZipFile` que ya está en `zip.js` (lee el directorio central en flujo por fd) |
| #20 / #25 no arranca (0xC0000005) | emulator imprime Userspace boot properties y sale con `exit 3221225477` | Los dos casos son NVIDIA + emulator 37.3.9.0 + `-gpu host`; el runtime de este equipo es la misma versión y se puede reproducir aquí |
| #26 instalación muy lenta / atascada preparando el runtime | La primera implementación se detiene en la descarga | `provision.installRuntimePack()` / ruta de descarga pieza a pieza de la fuente oficial; cortacircuitos por límite de Gitee |
| #23 la versión portátil con carpeta de runtime configurada sigue descargando a AppData | Reglas de rutas inconsistentes | La relación entre `paths().root` y `materializeImages` / `sysImgRoot` (ver 2.5) |
| #27 / #28 se ocultaban las ventanas de WeChat y UU Remote | Corregido en v0.3.4 (scope/IsOurs) | `agent.ps1:168`; basta con que el usuario actualice |
| PR #18 / #22 | Duplican implementaciones ya fusionadas | #18 lo sustituyó `b3fc7c2`; el orden de parámetros de `_qemuImg` de #22 ya se corrigió en `emulator.js:403` |

### 6.2 Defectos de implementación confirmados (comprobados línea a línea en el recorrido, sin corregir)

| # | Ubicación | Defecto | Impacto |
|---|---|---|---|
| 1 | `apk.js:78` / `installer.js:27` | `fs.readFileSync` lee el APK entero | Con 2 GB+ falla seguro (issue #21); en equipos con poca memoria analizar paquetes grandes también es peligroso |
| 2 | todo `zip.js` | **No hay Zip64** (`zip.js:29-30,37,161-162,180`) | Con más de 65535 entradas se pierden entradas en silencio; una entrada de más de 4 GiB da `RangeError` directo (las imágenes del sistema/paquetes de actualización acabarán chocando) |
| 3 | `assoc.js:62-63` | El «conservar la asociación previa del usuario» que promete el comentario no existe; al desinstalar se borra siempre el valor por defecto de `.apk` | Se pierde la asociación de APK que tenía el usuario; el módulo no tiene pruebas |
| 4 | `logfile.js:19-21` | Con `bak === file` borra antes de renombrar | Con nombres que no son `*.log` se pierde el registro (`appLog` es justo `app.log`, por eso no estalló) |
| 5 | `provision.js:531` + `sources.js:412` | Al empezar la implementación fija `percent:1` y luego mide **en serie** cada dirección hasta 9 s | 4 candidatas = más de 30 s sin progreso → el usuario cree que «se atascó preparando el runtime» (issue #26) |
| 6 | `provision.js:575-576` / `:790` | Los fallos al descomprimir `.xz` los tragan dos niveles de `catch` | El progreso se queda en 99 % y vuelve a «completar con la fuente oficial», descargando otra vez 1,4 GB en vano |
| 7 | `provision.js:262-277` | A la tabla `need` de `guardDisk` le falta `'runtime'` y solo estima 1536 MB | Paquete+descompresión ocupan en realidad unos 5 GB; tras pasar la guardia aún puede llenarse el disco |
| 8 | `updater.js:80` | Respaldo de la versión portátil `/\.zip$/i` | Si una versión solo tiene `LanzadorAPK-runtime-*.zip`, se tomaría por paquete de actualización y se descomprimiría en la carpeta del programa |
| 9 | `main.js:165-168` | `bootstrapBundledRuntime()` sobrescribe el `runtime.dir` del usuario cuando «la carpeta portátil trae runtime» | «Configuré la carpeta del runtime y sigue descargando a AppData» (issue #23) |
| 10 | `main.js:213` / `shortcut.js:120` | Los iconos WebP dependen de una BrowserWindow oculta para decodificarse | En escenarios de Node puro / sin GUI se degrada en silencio al icono provisional de marca, y «falló la decodificación» no se distingue de «no hay icono» |
| 11 | `apk.js:29,67` | La lista permitida de formatos de icono solo tiene `.png`/`.webp` y no recorre `<bitmap>` en XML | Iconos `.jpg` y combinaciones adaptive-icon pueden sacar la imagen equivocada |
| 12 | `arsc.js:65-77` | La puntuación de config usa constantes inventadas (`anydpi` resta 500, `language` resta 40) | Una app en chino podría obtener el nombre en inglés; las tres codificaciones de entry no tienen pruebas y al fallar vuelven en silencio al valor por defecto |

### 6.3 Problemas estructurales (se pueden hacer en la siguiente etapa)

1. **Unificar la ruta de archivos grandes**: cambiar `apk.js` / `installer.parseBundle()` al `ZipFile` existente (flujo por fd, desde `zip.js:128`): la memoria máxima pasa de «el tamaño del archivo» a «unos pocos MB» y de paso se resuelve el límite de 2 GB. Ojo: el `read()` de las dos clases tiene semántica distinta (`ZipArchive` devuelve null / `ZipFile` lanza error); al sustituir hay que agregar la comprobación `has()`;
2. **Agregar Zip64**: cuando el EOCD tiene `0xffff/0xffffffff`, ubicar el EOCD Zip64 (`0x06064b50`) y el locator (`0x07064b50`), y cambiar los 4 campos a u64;
3. **Dividir los archivos grandes**: separar por dominio los registros IPC de las 1790 líneas de `main.js` en `src/main/ipc/*.js`; dividir las 1064 líneas de `emulator.js` en tres bloques: «matriz de parámetros / instantáneas / partición de datos»;
4. **Capacidad de diagnóstico insuficiente** (los informes de #20/#25 tenían `attempts: []`, `bootLog: []`): al fallar, escribir `emulator.attempts` y el final de emulator.log en el informe de diagnóstico, y traducir el código de salida a texto legible (`3221225477` = violación de acceso 0xC0000005);
5. **Capa de compatibilidad de GPU**: `-gpu host` se cae con algunos controladores NVIDIA + emulator 37.3.9; se puede ampliar el mecanismo `badGpu` con «código de salida 0xC0000005 → degradar solo y recordarlo»;
6. **Huecos de pruebas** (por riesgo): AXML/ARSC sin casos de bytes sintéticos (si falta el APK real de prueba se omite todo → cero cobertura en CI), `arsc.resolve()` sin aserciones, `.apks/.xapk` sin casos, `assoc.js` sin cobertura, `pngToIco`/`writeShortcut` fuera de `npm test`;
7. **Recursos de Gitee distintos de los de GitHub** (en v0.3.4 Gitee solo tenía el paquete portátil): el proceso de publicación ya tiene `publish-gitee.js`, pero el CI necesita el secret `GITEE_TOKEN` para no fallar.

### 6.4 Los puntos de la cadena de implementación que más fallan (11 casos de referencia rápida)

| Síntoma (visto por el usuario) | Ubicación en el código | Mecanismo |
|---|---|---|
| Atascado en «Preparando el runtime» al 1~3 % | `provision.js:531` + `sources.js:412` | Medición en serie, sin progreso por bytes |
| Se para en 99 % y vuelve a «usar la fuente oficial» | `provision.js:575-576,790` | Se traga el fallo al descomprimir `.xz` |
| «Configuré la carpeta del runtime y sigue descargando a AppData» | `provision.js:217-224,726` + `main.js:165-168` | Las tres ramas de `sysImgRoot` usan la carpeta vieja + la toma de la versión completa sobrescribe la configuración |
| Hay disco de sobra pero dice que falta espacio | `provision.js:262-277` | La guardia solo estima 1,5 GB |
| El progreso se queda en 95 % | `download.js:446-503` | Los bloques finales de una fuente lenta retrasan todo; ya se agregó el cambio de fuente por lentitud + resolución garantizada |
| Tras cortarse la conexión se pierde toda la descarga | `download.js:155,188-191` | Al ver un archivo a medias se degrada a una sola conexión |
| La actualización se atasca en «Reemplazando el programa» | `updater.js:271,280-285,315-323` | El script de sobrescritura **no puede ser independiente**: los programas de seguridad lo bloquean |
| Aparece un archivo de 1,5 GB de más en la carpeta del programa | `updater.js:80` | El paquete completo del runtime se tomó como paquete de actualización |
| Una versión en Gitee no tiene instalador | `release.yml` + `sources.js:172-204` | Sin token falla directamente; las partes deben ser part1..N consecutivas |
| Tras cambiar de fuente sigue usando la dirección vieja | `main.js:819-825` | `provision._cache.*` no tenía forma de invalidarse; había que reiniciar |
| El AVD figura como «ya en uso» | `layers.js:87-90` + `engine.js:856` | Quedaron archivos `*.lock`; el panel de limpieza puede recuperarlos |

> **Tres «mira aquí primero» para quien toma el proyecto**
> 1. Una sola función explica el 80 % de los problemas de implementación: `Provisioner.checkEnv()` (`provision.js:367`);
> 2. Las reglas de rutas están en un solo lugar: `Provisioner.paths()` (`provision.js:197`); el código nuevo que guarde archivos del runtime debe tomar las rutas de ahí;
> 3. Las estrategias de descarga están reunidas en `Sources` + `downloadMulti`; no escribas otra en `provision.js`.

### 6.5 Registro de correcciones locales (v0.3.5-dev, sin publicar ni hacer push)

2026-11-14, segunda ronda de desarrollo: solo cambios en el área de trabajo local; `npm test` pasó de **98 a 113 casos, todos correctos**
(run-tests 3→8 + engine-test 25 + auto-test 70→80, con nuevos casos de regresión para APK sintético / paquetes divididos .xapk /
materializeImages / Zip64 / recursos de actualización / 0xC0000005 / límites de registros / fallos guardados en disco / armado del componente de inicio, etc.),
y se verificó de extremo a extremo un arranque en frío real (25 s) / en caliente (5 s, con instantánea) / apagado ordenado (instantánea guardada);
**prueba real con un APK sintético de 2,15 GB: análisis en 18 ms, RSS del proceso 47 MB** (la ruta vieja necesitaba unos 2,2 GB de memoria contigua);
`assoc` se probó con el registro real de este equipo en un ciclo completo «copia → registrar → anular → restaurar»
(la asociación original del equipo era `MuMuPlayer.apk` y se restauró tal cual).

| # | Qué se corrigió | Ubicación | Por qué |
|---|---|---|---|
| 1 | `parseApk` / `parseBundle` pasan a leer el ZIP en flujo desde archivo | `apk.js:80-95`, `installer.js:27-60` | Los APK de 2 GB+ ya no chocan con el límite de un Buffer de Node; cada parte de los paquetes divididos también va a disco en flujo |
| 2 | ZIP admite Zip64 (EOCD locator + extra id=0x0001) | `zip.js:9-92`, `zip.js:151-236` | Con más de 65535 entradas ya no se trunca en silencio; las entradas enormes ya no se salen de rango ni pierden el desplazamiento |
| 3 | El tiempo límite de `adb install` crece con el tamaño del paquete (máximo 20 minutos) | `adb.js:105-114` | Push + dexopt de un paquete de 2 GB supera los 4 minutos fijos |
| 4 | Implementación: la medición de velocidad muestra progreso (fuente i/n, 6 s por fuente) | `sources.js:408-424` | «Atascado preparando el runtime» ya no es un tramo de 30 s sin progreso |
| 5 | Los fallos al descomprimir imágenes ya no se tragan; se usa `.part` + renombrado atómico; «ya descomprimida» exige un tamaño no menor que el paquete comprimido (las imágenes a medias se vuelven a descomprimir) | `provision.js:766-826` | La versión vieja se paraba en 99 % y volvía a bajar 1,4 GB de la fuente oficial; un system.img a medias se tomaba como terminado |
| 6 | `guardDisk('runtime')` agrega una estimación de 5000 MB | `provision.js:262-268` | Paquete + descompresión llegan a unos 4,7 GB; la estimación vieja era de solo 1,5 GB |
| 7 | La carpeta del runtime fijada por el usuario ya no la sobrescribe el runtime incluido | `main.js:136-162` | issue #23 «configuré la carpeta y sigue descargando a AppData» |
| 8 | El respaldo `.zip` del actualizador excluye `LanzadorAPK-runtime-*.zip` | `updater.js:73-88` | Evita que, si una publicación no tiene paquete portátil, se descomprima como programa el paquete completo del runtime de 1,5 GB |
| 9 | Regla de diagnóstico de 0xC0000005 + degradación automática de GPU + fallos guardados en disco | `doctor.js:320-330`, `emulator.js` (`describeExitCode` / `_persistFailure` / `lastFailure` / `tailLogFile`), `engine.js:diagnostics` | issue #20/#25: la causa de `attempts: []`, `bootLog: []` y UNKNOWN en los informes era que los datos solo estaban en memoria |
| 10 | `assoc` restaura al desinstalar la asociación `.apk` que tenía el usuario | `assoc.js:40-135` | La implementación vieja borraba siempre el valor por defecto (la protección que prometía el comentario no existía) |
| 11 | Guardia de límite para `bak === file` en la rotación de registros | `logfile.js:15-30` | Con nombres que no son `.log` se borraba antes de renombrar y se perdía el registro |
| 12 | Iconos: jpg en la lista permitida, recorrido de iconos XML hasta 3 niveles, provisional distinguible con aviso leve | `apk.js:27-115`, `shortcut.js:109-140`, `installer.js:210-235,289-300` | Los iconos `.jpg`/adaptive-icon/layer-list ya no se convierten siempre en el provisional; si de verdad no se pueden decodificar se avisa al usuario |
| 13 | Interfaz de fallos de instalación: los avisos de error se centralizan en `install:error` y se quita el círculo de «Instalando» | `ui/app.js:469-520,1446-1460`, `main.js:566` | En la issue #21 «da error y abajo a la derecha sigue cargando» |
| 14 | Nuevas pruebas de regresión con «APK sintético»: manifiesto AXML propio + icono PNG + carpetas ABI, cubriendo la base `attributeStart`, `package` sin espacio de nombres, atributos enteros y el análisis de la Activity de inicio; los paquetes divididos `.xapk` y `materializeImages` (descomprimir/omitir/imagen dañada sin restos) tienen casos propios | `test/lib/make-apk.js`, `test/run-tests.js`, `test/auto-test.js` | Sin el APK real de prueba, axml/apk tenían cero cobertura en CI; la descompresión de imágenes es el paso más frágil de la implementación |
| 15 | **Tras una instalación nueva, al pulsar el icono solo se veía el escritorio de Android**: `startApp` armaba siempre `${pkg}/${activity}`, pero `resolveLauncher`/el registro de instalación nueva guardaban el componente completo `pkg/class` → el componente de `am start` quedaba `pkg/pkg/class` y el sistema lo cancelaba (result code=-92). Se agregó `componentArg()` para unificar ambas formas, y `parseResolvedActivity()` tolera líneas vacías/priority al final | `adb.js:105-131,520`, `test/auto-test.js` | Es un **error que ya existía en el original**, encontrado en pruebas reales (también en v0.3.4); solo afecta a «apps instaladas/reinstaladas de nuevo»; el apps.json viejo (solo nombre de clase) no lo dispara |

> Pendiente (para la próxima ronda): dividir el IPC de `main.js`, dividir `emulator.js`, hacer configurable la puntuación de config de `arsc`,
> separar los menús de bandeja/actualización de las 1790 líneas de `main.js`, casos de bytes sintéticos para `arsc.js` (`axml.js`/`apk.js`
> ya los cubren los casos de «APK sintético» de `test/run-tests.js`, sin depender de APK externos).

---

## 7. Apéndice: referencia rápida de módulos

### 7.1 Firmas exportadas de `src/core`

| Módulo | Exportaciones principales |
|---|---|
| `store.js` | `DATA_DIR/ICON_DIR/APK_DIR`, `getSettings/saveSettings/getApps/saveApps/upsertApp/removeApp/getApp/iconPath/apkPath/ensureDirs/DEFAULT_SETTINGS` |
| `engine.js` | `class Runtime`, `MONITOR_PORT` |
| `emulator.js` | `class EmulatorEngine` |
| `provision.js` | `class Provisioner` (`paths/checkEnv/installAdb/installEmulator/installSystemImage/installPlayImage/installAehd/installQemu/materializeImages/installRuntimePack/guardDisk/emulatorAccel/hypervisor`) |
| `installer.js` | `class Installer`, `accentOf` |
| `adb.js` | `class AdbClient`, `friendlyInstallError`, `friendlyLaunchError` |
| `apk.js` | `parseApk` |
| `zip.js` | `class ZipArchive` (paquete entero en memoria), `class ZipFile` (flujo por fd) |
| `appwin.js` | `class AppWindow`, `TITLEBAR_H` |
| `agent.js` | `class WinAgent`, `AGENT_SCRIPT` |
| `doctor.js` | `hostInfo/freeDiskMB/gpuCandidates/lcdFor/shortPath/liteProfile/chooseProfile/overridesFromSettings/autoProfile/planVariants/isPortFree/snapshotKey/imageIdentity/diagnose/describeProfile/writeReport/vcRedistOk` |
| `updater.js` | `class Updater` (`check/prepare/apply`, `repoUrl`) |
| `sources.js` | Listado/medición/caché/cortacircuitos de las dos fuentes (detalles en `_wip-provision-stack.md`) |
| `download.js` | `downloadMulti` / una sola conexión / reanudación / vigilante (detalles en el mismo lugar) |
| `container.js` | `nextSessionState/buildSessionCommands/buildIdleCommands/buildRestoreCommands/NEVER_TRIM` |
| `pointer.js` | `pointerOptions/hookOptions/wheelToSwipe/WheelRouter/isInputCommand` |
| `layers.js` | `summary/prune` (inventario y recuperación de las capas del contenedor) |

### 7.2 Documentación relacionada

- `docs/ARCHITECTURE.md`: arquitectura y decisiones de diseño orientadas al usuario (con los capítulos «modelo de contenedor» y «botones del ratón»);
- `docs/CODE-WALKTHROUGH-PARSE.md`: **recorrido archivo por archivo de la pila de análisis sin conexión** (zip / AXML / ARSC / PNG / apk / shortcut / assoc / version / logfile / display), con firmas de interfaz, trampas con número de línea, puntos de llamada, cobertura de pruebas y perfil de memoria de cada archivo;
- `docs/CODE-WALKTHROUGH-RUNTIME.md`: **recorrido archivo por archivo de la pila de descarga/implementación/actualización** (sources / download / provision / updater / store / layers / notify / android), con la elección entre las dos fuentes, bloques de varias fuentes, reanudación, reglas de rutas, script de sobrescritura de actualizaciones y una tabla de 14 problemas de implementación.

### 7.3 Partes que solo se pueden verificar en un equipo real (fuera del alcance del entorno aislado/CI)

- Flujo completo de arranque y sin fugas de ventanas: `tools/check-windows.js`, `check-console.js`, `check-launch-clean.js`, `check-quit-clean.js`;
- Tiempos de arranque en frío/caliente: `tools/e2e-boot.js` (datos históricos: en frío ~23 s, con instantánea ~5 s, de extremo a extremo con detección previa 30,7 s / 13,7 s);
- Cadena de actualización: `tools/check-update.js` (API real de GitHub + script de sobrescritura real);
- Botones del ratón, incrustación, rotación: `test/pointer-hook-logic.ps1`, `test/embed-probe*.ps1`, `test/win-*.ps1`.
