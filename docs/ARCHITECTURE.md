# Arquitectura

## Capas

```
┌─────────────────────────────────────────────────────────────┐
│ Presentación  src/ui (HTML/CSS/JS)  ←→  preload (contextBridge)   │
├─────────────────────────────────────────────────────────────┤
│ Orquestación  src/main.js (ventanas/bandeja/despacho CLI)       │
│               installer.js (cadena de instalación)              │
├─────────────────────────────────────────────────────────────┤
│ Dominio       engine.js (ciclo de vida/detección/liberación en reposo) │
│               adb.js (operaciones del dispositivo)  sharer.js (intercambio de archivos) │
├─────────────────────────────────────────────────────────────┤
│ Análisis sin conexión  zip.js → axml.js / arsc.js → apk.js      │
│                        png.js / shortcut.js (iconos y accesos directos) │
├─────────────────────────────────────────────────────────────┤
│ Adaptación del motor  QEMU propio (WHPX/TCG) │ importar imagen del sistema │ runtime existente (opcional) │
└─────────────────────────────────────────────────────────────┘
```

## Flujos clave

### 1. Instalar con doble clic en un APK

```
Doble clic en .apk desde el Explorador
  → HKCU\Software\Classes\LanzadorAPK.apk\shell\open\command
  → LanzadorAPK.exe "C:\...\xxx.apk"
  → main.js parseArgs → runInstall
      1. apk.js: análisis sin conexión (zip → manifiesto AXML → arsc recupera label/icon)
      2. engine.ensure(): si el runtime no está listo, se lanza/detecta automáticamente
      3. adb install -r -g -t
      4. Icono → PNG (icons/) + ICO de varios tamaños (icons/*.ico)
      5. shell.writeShortcutLink crea el .lnk del escritorio (--launch <pkg>)
      6. store.upsertApp guarda los metadatos
```

### 2. Inicio desde el icono del escritorio (experiencia nativa)

```
Doble clic en <nombre de la app>.lnk
  → LanzadorAPK.exe --launch <pkg>
  → el bloqueo de instancia única lo une a la instancia en ejecución (o lanza una nueva en silencio)
  → adb am start --windowingMode 5 -n <pkg>/<activity>
  → ventana freeform independiente
  → la ventana contenedora se oculta/sale sola, sin dejar interfaz de más
```

### 3. Intercambio de datos

```
Equipo %USERPROFILE%\LanzadorAPKShared  ⇄  Android /sdcard/LanzadorAPKShared
  Sincronización incremental en ambos sentidos (decide por mtime+size), sondeo cada 8 s + disparo en acciones clave
```

## Por qué no usar bibliotecas existentes

| Necesidad | Forma habitual | Forma de LanzadorAPK | Motivo |
|---|---|---|---|
| Leer metadatos del APK | aapt2 / apk-parser | zip+AXML+ARSC escritos a mano | Cero dependencias, sin instalar el SDK, sin procesos externos al iniciar |
| Icono a ICO | ImageMagick/sharp | escalado con nativeImage + contenedor ICO a mano | Evita 80 MB de dependencias nativas |
| Asociación de archivos | el instalador escribe en HKLM | HKCU + SHChangeNotify | Sin administrador, se activa/desactiva en cualquier momento desde la configuración |
| Emulador | empaquetar todo VirtualBox | capa de adaptación del motor | Reutiliza runtimes existentes sin coste; la ruta QEMU conserva una imagen del sistema controlable |

## Diseño de estabilidad

- Todas las llamadas a adb tienen tiempo límite y errores normalizados (AdbError).
- La detección del runtime se hace en paralelo, con 4 s de límite y degradación automática si falla.
- Vigilante de reposo de QEMU: solo libera si no hay app en primer plano y pasaron los minutos configurados; si hay una app corriendo nunca libera.
- La configuración y la lista de apps se escriben de forma atómica con tmp+rename.

## Modelo de contenedor por app (rendimiento)

### El límite con un «contenedor de verdad»

Huawei Easy Share / WSA / Anbox son **contenedores o capas de compatibilidad**: el anfitrión y el invitado comparten núcleo,
los servicios del sistema se lanzan bajo demanda y en teoría se pueden cargar solo los servicios que necesita una app.
La base de LanzadorAPK es Google Android Emulator (virtualización completa con QEMU),
el núcleo Linux, zygote y system_server tienen que arrancar completos una vez; **no se puede «cargar solo los servicios
que necesita una app»**, y eso no se evita con código de capas superiores.

Pero lo «pesado» que siente el usuario no viene de esos servicios residentes, sino de otras cuatro cosas.
Resolviéndolas, la experiencia equivale a «abrir cada vez solo el entorno que la app necesita»:

| La carga real | Cómo se trata | Dónde está |
| --- | --- | --- |
| Cada app abierta volvía a arrancar Android completo (40~142 s, CPU/disco al máximo) | El entorno arranca una sola vez y queda residente; el qemu independiente sigue vivo tras salir de LanzadorAPK, la próxima vez `adoptExisting()` lo toma + instantánea quickboot; abrir solo hace `am start` + enganchar la ventana | `engine.js` / `emulator.js` |
| Las apps abiertas antes quedaban en segundo plano usando memoria y red | Al abrir una app nueva, `am force-stop` a las demás apps del usuario; al cerrar la última ventana, `am kill-all` + `deviceidle force-idle` | `container.js` / `Runtime.beginApp()` / `endApp()` |
| qemu con prioridad Normal compite por CPU con el escritorio de Windows | Tras iniciar baja a `BelowNormal` y al aparcar el contenedor a `Idle`; las vCPU se ajustan a 1/4 de los núcleos físicos (2~3) | `win/priority.ps1` / `doctor.liteProfile()` |
| Sin apps, la sincronización, las notificaciones y la revisión de ventanas seguían sondeando a toda velocidad | La sincronización de archivos y el puente de notificaciones solo se activan con ventanas de app; la revisión de ventanas se limita a 8 s tras la incrustación; el bucle principal del socket pasa a sondeo corto de 50 ms | `main.js` / `win/agent.ps1` |

### Sobre «traducir el APK a x86»

Este paso **no se hace cada vez que se abre** y ya viene incluido:
- La imagen del sistema es x86_64; los APK nativos x86 corren directamente;
- Los APK solo ARM dependen del native bridge de la imagen (la capa de traducción binaria
  ARM→x86 que trae la imagen Google Play), que actúa **al instalar** y se usa bajo demanda en ejecución;
- Por eso LanzadorAPK no necesita, ni debe, volver a «traducir» en cada inicio.
  «Traducir en cada apertura» sería justamente el diseño más lento.

### La causa de que el ratón se desviara / todo el equipo fuera lento (corregido)

`win/agent.ps1` usaba el gancho global de bajo nivel `WH_MOUSE_LL` para el «botón lateral = atrás»,
pero lo instalaba en el hilo del servicio de ventanas, que a la vez se bloqueaba en `sock.Poll(4000)`.
Cada evento de ratón de Windows tenía que esperar de forma síncrona a que ese hilo volviera, hasta 4 s;
tampoco se quitaba al cerrar la ventana: mientras LanzadorAPK vivía, frenaba todo el sistema.
Sumado al pico de E/S de la primera inicialización (descomprimir `.xz` / `e2fsck` / `resize2fs`),
el primer plano casi no conseguía recursos.

Corrección:
- El gancho ya no queda residente sin condiciones: solo se instala en un **hilo de mensajes dedicado** (bucle `GetMessage`), y solo cuando
  la ventana de la app está en primer plano y al menos un mapeo del ratón está activo; al perder el foco/cerrar se quita al instante; el callback solo maneja
  7 mensajes objetivo, el resto (incluidos todos los del botón izquierdo) pasa directo con un `CallNextHookEx`;
- Bucle principal del servicio: `Poll(4000)` → `Poll(50)`;
- `EnumWindows` + `SetWindowPos(SWP_FRAMECHANGED)` pasa de «cada 2 s para siempre» a
  «durante 8 s tras la incrustación, y sin forzar a recalcular el área no cliente»;
- La primera implementación se retrasa 20 s, para no competir por E/S con el arranque en frío.

### Botones del ratón (izquierdo confirma / derecho atrás / rueda desliza)

En la ventana de la app va incrustada la subventana Qt del emulador; el mapeo nativo es:

| Entrada | Comportamiento nativo de Qt | Lo que hace LanzadorAPK |
| --- | --- | --- |
| Izquierdo | toque / mantener y arrastrar = deslizar | **No se intercepta nada**, pasa directo; esto es «confirmar» |
| Derecho | también cuenta como un toque, fácil de pulsar sin querer | Intercepta `WM_RBUTTONDOWN/UP/DBLCLK` y envía `input keyevent 4` (atrás) |
| Rueda | cada paso envía un evento táctil aparte, la imagen da saltos | Intercepta `WM_MOUSEWHEEL/MOUSEHWHEEL` y en ventanas de 60~90 ms los une en un `input swipe` |
| Laterales | nada | Opcional: atrás / adelante (desactivado por defecto) |

La unión de la rueda ocurre en `win/agent.ps1` (`PushWheel` / `FlushWheel`) y la traducción en
`core/pointer.js` (`WheelRouter` → `wheelToSwipe`). La inyección va por el **`adb shell` residente**
de `AdbClient.input()`, con `echo __LANZADORAPK_<id>__` como respuesta y contrapresión;
no lanza un proceso adb con `execFile` por cada paso de la rueda ni deja comandos de deslizamiento en cola en la shell.
Las coordenadas se mapean por la posición normalizada del cursor dentro del LCD; la rueda horizontal genera deslizamiento horizontal y tras rotar se actualiza la resolución.

El gancho solo se instala con la ventana de la app en primer plano y se quita al volver al escritorio o cerrar; si se apagan clic derecho = atrás, rueda suave
y botones laterales, no se instala ningún gancho global.

### Opciones configurables (Configuración → Botones del ratón / Rendimiento y contenedor ligero)

| Opción | Por defecto | Descripción |
| --- | --- | --- |
| `engine.mouseRightBack` | `true` | Clic derecho = atrás de Android; si se apaga vuelve el «clic derecho también es toque» de Qt |
| `engine.mouseWheelMode` | `smooth` | `smooth` inyección unida / `native` Qt lo maneja paso a paso / `off` sin intercepción |
| `engine.mouseSideButtons` | `false` | Botones laterales atrás / adelante; con las tres opciones apagadas no se instala el gancho global |
| `engine.liteMode` | `true` | Ajusta la cuota de vCPU; al apagarlo se asignan más núcleos según el equipo |
| `engine.priorityMode` | `balanced` | Con `performance` qemu usa prioridad Normal |
| `engine.deepTrim` | `false` | Además hace `pm disable-user` a un grupo de paquetes del sistema en segundo plano; al apagarlo se restauran con `pm enable` |

El recorte profundo evita a propósito `gms` / `systemui` / webview / teclado y otros componentes necesarios
(ver `container.NEVER_TRIM`), para que las apps que dependen de notificaciones push e inicio de sesión no den errores una y otra vez.

### Ciclo de vida de una sesión

```
Arranque en frío (solo la primera vez, o tras borrar el AVD)
  materializeImages → e2fsck/resize2fs → boot_completed → saveSnapshot
        ↓
Abrir la app A: ensure() toma el entorno residente → am start A → enganchar la ventana
            → beginApp(A): detener las demás apps del usuario, subir la prioridad, activar sincronización/notificaciones
        ↓
Pasar a la app B: beginApp(B) → am start B (sin reiniciar Android)
        ↓
Cerrar la última ventana: endApp() → force-stop → am kill-all → deviceidle
            → qemu baja a Idle → se detienen sincronización/notificaciones (contenedor aparcado, sin apagar)
        ↓
Reposo más largo que idleShutdownMinutes: el vigilante apaga el runtime
(las instancias tomadas antes no se podían liberar por no tener el identificador proc local; ya corregido)
```
