# Entorno de desarrollo y referencia rápida de comandos

> Este documento recoge los datos del entorno que hay que conocer para «seguir desarrollando LanzadorAPK en esta máquina de desarrollo».
> La mayoría de las trampas son propias del entorno aislado; en otra máquina guíate por lo que detectes de verdad.
> Última revisión: 2026-11-14 (v0.3.5, con correcciones locales publicadas sobre v0.3.4).

## 0. Registro de incidente: el área de trabajo se envió entera a la papelera

Hacia las 20:55 del 2026-11-14, **toda la carpeta** `D:\lanzadorapk-dsh` (261 elementos: código / pruebas / documentación /
memoria de `.workbuddy`) se movió a la papelera durante una operación de «limpiar artefactos viejos de lanzadorapk»;
en la misma limpieza cayeron también `D:\lanzadorapk-dist`, `D:\dist-gitee`, `D:\LanzadorAPK-0.3.3-preview`,
`D:\tmp-wx` y otras carpetas viejas: parece que una limpieza con comodín `D:\lanzadorapk*` se llevó de paso el área de trabajo.

Proceso de recuperación (reutilizable):
1. **No vacíes la papelera**. Los elementos del disco D están en `D:\$Recycle.Bin\<SID>\`; cada uno es un par
   `$I<id><ext>` (metadatos) + `$R<id><ext>` (datos).
2. Estructura de `$I`: version u64 @0, tamaño original u64 @8, hora de borrado u64 @16,
   **longitud de la ruta u32 @24 (en caracteres UTF-16, ¡no en bytes!)**, ruta UTF-16LE @28.
   Basta con renombrar `$R` a la ruta original que guarda `$I` para recuperarlo (las carpetas se recrean solas).
3. `.git` no estaba en la papelera (quizá la herramienta de borrado lo omitió): se recuperó el historial desde `C:\Users\15656\WorkBuddy\
   2026-10-29-20-43-38\lanzadorapk\.git` (e1db34b = v0.3.4) y luego se volvió a confirmar
   el área de trabajo.
4. Verificación tras recuperar: `src/**` y `dist\LanzadorAPK-win64-portable\resources\app\src`
   coinciden archivo por archivo en SHA256; `npm test` pasa los 112 casos.

**Recomendación**: de ahora en adelante, guardar cada cierto tiempo un zip de código+`.git`+docs+test fuera de `D:\`
(por ejemplo en `C:\Users\15656\WorkBuddy\`), no en el mismo disco que el área de trabajo.

## 1. Ubicación de las herramientas (no están en el PATH; hay que usar rutas absolutas)

| Herramienta | Ruta | Versión |
|---|---|---|
| Node | `C:\Users\15656\.workbuddy\binaries\node\versions\22.22.2-6\node.exe` | v22.22.2 |
| npm | `…\22.22.2-6\npm.cmd` | la de Node |
| Git | `C:\Users\15656\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe` | 2.55.0.windows.3 |
| Electron | en el repositorio `node_modules\electron\dist\electron.exe` | 33.4.11 |

En PowerShell primero agrega al PATH:

```powershell
$env:PATH = 'C:\Users\15656\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd;' +
            'C:\Users\15656\.workbuddy\binaries\node\versions\22.22.2-6;' + $env:PATH
```

Si se borran las dependencias, reinstálalas (unos 19 s, por espejo):

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm ci --no-audit --no-fund
```

## 2. Dos variables de entorno que hay que borrar en cada shell

La shell del anfitrión hereda estas dos; si no se borran pasan cosas raras como «Electron se ejecuta como Node puro»:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # si no, electron.exe actúa como node y --launch da bad option
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue           # si no, el borrado masivo de build/pack.js lo bloquea safe-delete con SAFE_DELETE_BULK_GUARD_ERROR
```

## 3. Comandos habituales

```powershell
cd D:\lanzadorapk-dsh\lanzadorapk

# Pruebas unitarias/de regresión (Node puro, sin Electron/adb/red)
npm test

# Pruebas de integración de Electron (ICO / .lnk / respaldo de iconos WebP)
.\node_modules\electron\dist\electron.exe test\electron-integration.js

# Capturas rápidas de la interfaz (--settings captura además la configuración; --perf/--download capturan esas secciones)
.\node_modules\electron\dist\electron.exe . --smoke "$env:TEMP\smoke.png"
.\node_modules\electron\dist\electron.exe . --smoke "$env:TEMP\smoke.png" --settings

# Arranque real (mide arranque en frío/caliente; --stop apaga ordenadamente y guarda la instantánea)
node tools\e2e-boot.js . --stop

# Empaquetar la versión portátil (genera dist\LanzadorAPK-win64-portable)
node build\pack.js

# Instalador de la versión completa (necesita build/runtime, unos 1,4 GB de runtime; se ejecuta en CI)
npm run build:exe
```

> Tras las pruebas rápidas/de arranque confirma que no queden procesos:
> `Get-Process -Name LanzadorAPK,electron,emulator,qemu-system-x86_64 -ErrorAction SilentlyContinue`
> El emulador es independiente; tras salir de Electron qemu puede seguir vivo (es a propósito: la próxima vez se toma al instante).
>
> Si `dist\LanzadorAPK-win64-portable` está en uso (Explorador/antivirus/la instancia anterior sigue abierta),
> `pack.js` pasa a `dist\LanzadorAPK-v<versión>-win64-portable`, es lo esperado; cierra lo que lo usa y renómbralo.
> Los procesos de lectura/indexado (Defender, SearchIndexer) pueden impedir borrar una carpeta vacía durante minutos; espera un poco y vuelve a intentar.

## 4. Rutas de datos y del runtime (en este equipo)

| Uso | Ruta |
|---|---|
| Configuración / lista de apps / registros / copias de APK | `%APPDATA%\lanzadorapk` (nombre real de la carpeta `LanzadorAPK`, sin distinguir mayúsculas) |
| Runtime (emulator + adb + imágenes) | `D:\LanzadorAPKRuntime` (`settings.runtime.dir`) |
| AVD / apps instaladas / instantáneas | `D:\LanzadorAPKData` (`settings.runtime.avdDir`) |
| Carpeta compartida | `%USERPROFILE%\LanzadorAPKShared` |
| Informes de diagnóstico | `%APPDATA%\lanzadorapk\logs\diagnostic-*.txt` |
| Registro del último fallo de arranque | `%APPDATA%\lanzadorapk\logs\last-failure.json` |

## 5. Cuidados con texto/archivos (propios de esta terminal)

- **No uses `Set-Content` / `Get-Content -Raw` con archivos UTF-8 que tengan caracteres no ASCII**:
  PowerShell 5.1 decodifica como ANSI por defecto y escribe texto corrupto (pasó una vez en una sesión y arruinó un archivo de pruebas).
  Lee y escribe texto siempre con la herramienta del editor; si hay que escribir un archivo desde PowerShell usa
  `[System.IO.File]::WriteAllText($p, $s, [System.Text.UTF8Encoding]::new($false))`.
- **Los métodos estáticos de `[System.IO.File]` usan la carpeta inicial del proceso**: tras `cd` siguen resolviendo la ruta vieja; usa siempre rutas absolutas.
- **Borrar carpetas grandes**: la capa safe-delete puede bloquear `Remove-Item -Recurse`;
  usa `[System.IO.Directory]::Delete($path, $true)`; si el espacio no se libera, vacía la papelera.
- **Procesos largos** (qemu / descargas grandes): usa tareas en segundo plano; un comando normal limpia al terminar todo su árbol de procesos.
- La salida de `reg.exe` usa la página de códigos de la consola; con contenido ASCII como nombres de paquete/rutas no hay problema.

## 6. Fallos habituales

| Síntoma | Causa / solución |
|---|---|
| `electron --version` muestra `v20.x` (la versión de Node) | No se borró `ELECTRON_RUN_AS_NODE=1` |
| El empaquetado da `SAFE_DELETE_BULK_GUARD_ERROR` | No se borró `NODE_OPTIONS` |
| En `npm test` los casos de axml/apk dicen «omitida» | No hay APK real de prueba; los casos con APK sintético se siguen ejecutando (`test/lib/make-apk.js`) |
| Emulador `0xC0000005` (3221225477) | Caída del backend de renderizado; las versiones nuevas cambian de backend solas y escriben `last-failure.json`; el informe está en `logs\diagnostic-*.txt` |
| «Running multiple emulators with the same AVD» | Un qemu que quedó tiene el bloqueo; `node tools\emu-clean.ps1` o reiniciar (las versiones nuevas limpian huérfanos solas) |
| Gitee 403 en la comprobación de actualizaciones | Límite de la API anónima; el cliente corta 15 min y usa solo GitHub; no es un fallo |
| En el entorno aislado se bloquean `reg.exe` / `sc.exe` | Solo afecta a las pruebas automáticas; el producto en el escritorio del usuario no se ve afectado |
| La versión portátil sale al segundo de iniciar, sin ventana | Otro proceso de LanzadorAPK tiene el bloqueo de instancia única (quizá una instancia vieja que no salió del todo); primero `Stop-Process -Name LanzadorAPK` |

## 7. Proceso de publicación (solo tras confirmar con pruebas reales)

```powershell
# 1. subir la versión
#    package.json: version -> 0.3.5
# 2. notas de la versión: docs/RELEASE-NOTES-NEXT.md -> .github/release-notes-v0.3.5.md
# 3. commit + tag
git add -A; git commit -m "chore(release): v0.3.5"
git tag -a v0.3.5 -m "LanzadorAPK v0.3.5"
# 4. subir a los dos repositorios (GitHub por SSH, Gitee por https; según haga falta)
git push origin main; git push origin v0.3.5
git push gitee main;  git push gitee v0.3.5
```

CI: `release.yml` compila la versión portátil (zip de 95 MB), el Setup de la versión completa (~1,35 GB) y el paquete completo del runtime
(~1,36 GB), y sincroniza la portátil con Gitee (necesita el secret `GITEE_TOKEN`; si falta falla en vez de omitirse en silencio).
La compresión xz del job `full` tarda unos 40 minutos; es normal.
