# Controladores (parches de compatibilidad)

> Desde LanzadorAPK 0.5.7 se admiten extensiones de «controladores»: un controlador = un archivo JSON que declara
> **a qué equipos se aplica** + **qué parámetros de arranque cambia cuando coincide**.
> El propio usuario puede escribir un parche para «mi equipo», sin esperar a una nueva versión de LanzadorAPK.

---

## 1. Qué problema resuelve

Un mismo conjunto de parámetros por defecto no puede funcionar en todos los equipos:

- En gráficos integrados viejos GLES solo llega a 3.1 y con `-gpu host` el invitado se cae a los pocos segundos de arrancar;
- Si el equipo no tiene activada la «Plataforma del hipervisor de Windows», la aceleración por hardware falla seguro y hay que ir directo a emulación por software;
- Con cierta versión de controlador de GPU, activar Vulkan da pantalla negra y cambiando a `swangle` se arregla;
- Algunas combinaciones de proporción de pantalla / DPI necesitan cambiar `hw.lcd.density` para que no se vea borroso.

Estas diferencias son **propiedades del equipo**, no errores del programa. Ponerlas en el código obligaría a publicar una versión cada vez;
como archivos de datos, cuando el usuario (o la comunidad) encuentra una combinación que funciona, basta un JSON para compartirla.

## 2. Dónde se guardan

| Carpeta | Uso |
|---|---|
| Configuración → Controladores → **Abrir carpeta de controladores** | Tus controladores, `%APPDATA%\lanzadorapk\drivers\*.json` (la versión de la Store en `%USERPROFILE%\LanzadorAPK\data\drivers`) |
| Carpeta de instalación `resources/app/src/drivers/` | Ejemplos incluidos, de solo lectura, `enabled: false` por defecto |

Con el mismo `id`, **la carpeta del usuario sustituye a la incluida**: para cambiar un ejemplo oficial, expórtalo/cópialo a la carpeta del usuario y edítalo; no hace falta tocar la carpeta de instalación.

## 3. Cómo es un controlador

```json
{
  "format": "lanzadorapk-driver/1",
  "id": "amd-igpu-swangle",
  "name": "Gráficos integrados AMD con renderizado swangle",
  "version": "1.0.0",
  "author": "Tu nombre",
  "description": "Explica por qué este equipo necesita este cambio, para que otros lo entiendan de un vistazo",
  "priority": 0,
  "match": {
    "platform": ["win32"],
    "gpuVendor": ["amd"],
    "totalMB": { "min": 8192 },
    "accel": ["whpx"]
  },
  "effect": {
    "gpuMode": "swangle",
    "forceTcg": false,
    "emulatorArgs": ["-feature=Vulkan"],
    "configIni": { "hw.gpu.mode": "swangle" },
    "env": { "ANDROID_EMUGL_VERBOSE": "1" },
    "notes": ["Si sigue en negro, cambia gpuMode a software"]
  }
}
```

### 3.1 Campos de primer nivel

| Campo | Obligatorio | Descripción |
|---|---|---|
| `format` | ✅ | Siempre `lanzadorapk-driver/1` |
| `id` | ✅ | Letras, números y `. _ -`, de 3 a 64 caracteres; al importar se usa como nombre de archivo |
| `name` | ✅ | Nombre que se muestra en la interfaz (≤80 caracteres) |
| `version` | ✅ | Del tipo `1.0.0`; si cambias el parche, sube la versión |
| `author` / `description` / `homepage` | | Para personas, para que otros sepan si les sirve |
| `enabled` | | Interruptor por defecto del archivo; en los ejemplos incluidos es `false`. El interruptor de la interfaz tiene prioridad |
| `priority` | | `-100~100`, 0 por defecto. **Cuanto mayor, más tarde se aplica** (sobrescribe a los aplicados antes) |
| `match` | ✅ | Condiciones de coincidencia, ver 3.2 |
| `effect` | ✅ | Qué cambia al coincidir, ver 3.3 |

### 3.2 `match`: si este equipo lo usa

Deben cumplirse todas las condiciones (AND); sin ninguna condición no coincide; para «todos los equipos» escribe `{"any": true}`.

| Clave | Valor | Descripción |
|---|---|---|
| `any` | `true` | Coincide con todos los equipos (útil como respaldo base) |
| `platform` | `win32` / `linux` | |
| `arch` | `x64` / `arm64` | |
| `gpuVendor` | `nvidia` / `amd` / `intel` / `unknown` | Clasificación por nombre de GPU; admite arreglos |
| `gpuName` | cadena regex (≤200 caracteres) | Por ejemplo `"radeon\\s+780m"`, sin distinguir mayúsculas |
| `cpuVendor` | cadena o arreglo | Coincide con el texto del modelo de CPU |
| `accel` | `whpx` / `aehd` / `none` | Estado actual de la aceleración por hardware; `none` = solo emulación por software |
| `osBuild` | número o `{min,max}` | Número de compilación de Windows, por ejemplo 22631 |
| `totalMB` | `{min,max}` | Memoria física (MB) |
| `cores` | `{min,max}` | Número de núcleos lógicos |
| `emulatorVersion` | `{min,max}` | Comparación numérica, `36.4.9 < 36.4.10` |

En la configuración cada controlador muestra «Coincide: gpu=amd / accel=whpx» o «No coincide con este equipo»,
así no hay que adivinar por qué no se aplicó.

### 3.3 `effect`: qué cambia al coincidir

| Campo | Descripción |
|---|---|
| `gpuMode` | Fija el backend de renderizado: `auto` / `host` / `swangle` / `swiftshader` / `swiftshader_indirect` / `software`. `auto` = no intervenir |
| `forceTcg` | `true` = desactiva la aceleración por hardware y usa emulación por software (equivale a `-accel off`) |
| `emulatorArgs` | Parámetros extra para emulator, de la forma `-flag=valor`; solo los de la lista permitida |
| `configIni` | Sobrescribe el `config.ini` del AVD; solo claves de la lista permitida |
| `env` | Variables de entorno extra; solo los prefijos `ANDROID_` / `QEMU_` / `LIBGL_` / `MESA_` / `EMUGL_` |
| `notes` | Texto explicativo; se muestra en el registro de arranque y en la configuración |

`gpuMode` y `forceTcg` se aplican a **cada ronda** de intento de arranque (incluidos los reintentos automáticos con degradación):
si el controlador dice «este equipo solo puede usar swangle», no tiene sentido probar antes el backend que ya falló.

## 4. Lista permitida: qué se puede cambiar y por qué

Los controladores se pueden descargar de internet y compartir, así que LanzadorAPK limita mucho sus permisos:

**No se permite ejecutar ningún código**. Un controlador es JSON puro: sin ganchos de script, sin `eval`, y nunca hace `require` de archivos tuyos.

**`emulatorArgs` solo acepta**

| Parámetro | Valores permitidos |
|---|---|
| `-gpu` | Backends de renderizado conocidos (ver la tabla de arriba) |
| `-accel` | `auto` / `off` / `on` / `whpx` / `hax` / `haxm` / `aehd` / `tcg` |
| `-feature` | Letras, números y `_,.-`, ≤160 caracteres |
| `-gltransport` | `pipe` / `asgpu` / `virtio` |
| `-qemu` | Un solo parámetro de qemu, con conjunto de caracteres limitado, ≤120 caracteres |
| Interruptores | `-no-audio` `-no-boot-anim` `-no-metrics` `-no-snapshot` `-no-snapshot-load` `-no-snapshot-save` |

Rechazados explícitamente: `-wipe-data` (borra apps y partidas), `-partition-size`, `-datadir`, `-sysdir`,
`-avd`, `-port`, `-http-proxy`. Estos o destruyen datos o rompen las ubicaciones que administra el propio LanzadorAPK.

**`configIni` solo acepta**: `hw.gpu.mode`, `hw.gpu.enabled`, `hw.gltransport`, `hw.keyboard`,
`hw.audioInput`, `hw.audioOutput`, `hw.camera.back`, `hw.camera.front`, `hw.gps`,
`vm.heapSize`, `hw.lcd.density`.
`disk.dataPartition.size`, `hw.ramSize`, `hw.cpu.ncore`, `image.sysdir.*` se rechazan siempre:
LanzadorAPK los escribe según la configuración, y cambiarlos a la vez solo produce conflictos.

**`env`**: `ANDROID_*`, `QEMU_*`, `LIBGL_*`, `MESA_*`, `EMUGL_*`; valores ≤200 caracteres y sin saltos de línea.
`PATH`, `SystemRoot`, `NODE_OPTIONS` y similares se rechazan directamente.

## 5. Cómo hacer tu propio controlador

1. Configuración → Controladores → **Exportar plantilla de este equipo** (`match` ya viene con los datos del equipo y se guarda en la carpeta de controladores);
2. Ábrelo con el Bloc de notas / VS Code y cambia `effect`:
   - Pantalla negra / imagen corrupta → prueba primero `"gpuMode": "swangle"` y, si no, `"software"`;
   - El equipo no tiene aceleración por hardware → `"forceTcg": true`;
   - Guarda los cambios;
3. Vuelve a la configuración y pulsa **Actualizar**; debe decir «Coincide con este equipo / Aplicado»;
4. Abre una app para comprobarlo, y apaga y vuelve a arrancar para confirmar que es estable;
5. Para compartirlo: envía el JSON y la otra persona usa «Importar controlador…».

Un controlador mal escrito no afecta al arranque: los archivos que no pasan la validación solo aparecen en la lista de errores de la configuración,
y los que no coinciden no se aplican en absoluto.

## 6. Resolución de problemas

- El registro de arranque (Configuración → Diagnóstico / `%APPDATA%\lanzadorapk\logs\emulator.log`) incluye:
  `drivers: amd-igpu-swangle@1.0.0`, además del `-gpu` / `-accel` real de cada ronda;
- En la configuración cada controlador dice «coincide / no coincide / desactivado» y qué condiciones cumplió;
- Si un archivo no carga (error de sintaxis JSON, campo mal escrito, más de 256 KB) se indican el archivo y el motivo;
- Para excluir un controlador temporalmente: apaga su interruptor en la interfaz (se guarda en la configuración, no se borra el archivo).

## 7. Ejemplos incluidos

Tres ejemplos en `src/drivers/`, **desactivados** por defecto:

| Archivo | Escenario |
|---|---|
| `example-amd-igpu-swangle.json` | Gráficos integrados AMD + controlador viejo; con `-gpu host` arranca y luego se cae |
| `example-no-hypervisor-tcg.json` | Sin aceleración por hardware; directo a emulación por software |
| `example-intel-igpu-software.json` | Gráficos integrados Intel viejos; falla la inicialización de GLES |

También sirven de documentación: cambiando `match` se convierten en un parche «solo para mi equipo».
