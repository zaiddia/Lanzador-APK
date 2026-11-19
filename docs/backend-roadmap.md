# Evaluación de bases Android (rama v0.5.0)

> Contexto: v0.4.3 usaba el emulador nativo de Google + ventana Qt, incrustada luego en una ventana de Electron.
> La incrustación tiene una serie de problemas de origen (bordes negros, coordenadas desplazadas, no llena la ventana, choques de orientación del panel Qt).
> Este documento recoge la evaluación de viabilidad de «cambiar de base» y lo que se implementó realmente en v0.5.0.

## Resumen de conclusiones

| Opción | Rendimiento | Estabilidad | Distribución/cumplimiento | Trabajo | Conclusión |
|------|------|--------|-----------|--------|------|
| **A. Emulador actual + modo de ventana independiente** | medio | alta | sin problemas | poco | ✅ **implementado en v0.5.0** |
| **B. Waydroid + WSL2** | alto | media | sin problemas | mucho | ⚠️ posible, pero con requisitos duros |
| **C. Waydroid + VM Linux ligera** | alto | media | sin problemas | mucho | ⚠️ igual que B, y más pesado |
| **D. Tencent App Store para PC** | alto | alta | ❌ código cerrado | — | ❌ no viable |
| **E. Microsoft WSA** | alto | — | ❌ sin soporte | — | ❌ no viable |
| **F. Cambiar a FydeOS / PhoenixOS / Bliss OS** | alto | media | sin problemas | enorme | ❌ choca con el enfoque del producto |

## A. Modo de ventana independiente (implementado)

En vez de meter la ventana del emulador en la nuestra con `SetParent`, el emulador abre su propia
ventana nativa y nosotros solo nos encargamos de «abrir la app → poner esa ventana delante del usuario».

**Por qué es mejor que seguir arreglando la incrustación**: los problemas del modo incrustado (bordes negros, coordenadas desplazadas, clics que no
corresponden, no llenar la ventana) vienen todos de «manejar una ventana Qt/OpenGL como una subventana normal». Cada
arreglo provoca el siguiente. En modo independiente el renderizado, el mapeo de entrada y el ajuste de tamaño
los hace el propio emulador, que es justo lo que mejor sabe hacer.

**Implementado**:
- Opción `display.windowEmbed` (`embed` / `detached`), elegible en la interfaz.
- `appwin.openDetached()`: oculta la ventana contenedora vacía → quita la relación padre-hijo → muestra la ventana nativa →
  la centra según la proporción de la pantalla.
- `agent.ps1` agrega los comandos `layout` / `detach` / `perf`; con `_detachedMode`
  la lógica de limpieza hace lo mínimo y no oculta como estorbo la ventana que el usuario está viendo.
- El tamaño debe **darse bien a la primera según la proporción de la pantalla**: la ventana nativa del emulador fija su propia proporción y una equivocada
  se corrige sola (con 1280 de ancho, en realidad quedan 400).

**Prueba real** (Ryzen 7 8745HS / Win10 26300 / AEHD):
una app de video ocupa toda la ventana nativa `Android Emulator - lanzadorapk:5554`,
con orientación correcta, clics que corresponden y sin bordes negros.

**Coste**: hay un icono más en la barra de tareas y el aspecto no es del todo igual al de la ventana principal.

## B / C. La ruta Waydroid

Waydroid es una solución de contenedor LXC (no una máquina virtual) que reutiliza el núcleo Linux del anfitrión para ejecutar Android directamente
framework de Android, y los gráficos se dibujan directamente en Wayland, así que rinde bastante mejor que cualquier emulador.

**Requisitos duros** (hacen falta todos):

1. **Un núcleo Linux que funcione**, compilado con binder / ashmem.
   - El núcleo oficial de WSL2 de Microsoft **quita binder por defecto**; hay que compilar uno propio desde
     `microsoft/WSL2-Linux-Kernel` con `CONFIG_ANDROID_BINDER_IPC`
     y otras opciones, y sustituirlo.
2. **Una sesión Wayland**. Waydroid no funciona sobre X11.
3. **El nodo de renderizado GPU `/dev/dri/renderD*`**, y **no admite el controlador propietario de NVIDIA**.
4. **La infraestructura de Hyper-V / WSL2** (si se va por WSL2).

**Situación real de este equipo**:

| Requisito | Estado |
|------|------|
| `HypervisorPresent` | `False`: Hyper-V no está activado |
| WSL | Solo el stub `wsl.exe`, **sin ninguna distribución** |
| AEHD | En ejecución (el emulador lo usa para acelerar) |
| GPU | AMD Radeon 780M (cumple, no es NVIDIA) |
| CPU / RAM | 16 hilos / 31,3 GB (de sobra) |

**Conflicto clave**: LanzadorAPK acelera hoy con **AEHD** (Android Emulator Hypervisor Driver).
AEHD y Hyper-V son **incompatibles**: al activar Hyper-V, AEHD deja de funcionar. Por eso
Waydroid no puede convivir al mismo tiempo con la base de emulador actual en el mismo equipo; hay que elegir uno.

**La opción C (VM Linux ligera) es más pesada que B**: hay que ejecutar en Windows una máquina virtual Linux
completa (QEMU/VirtualBox/Hyper-V) y dentro instalar Waydroid: dos capas de virtualización +
empaquetar y distribuir una distribución Linux entera. El tiempo de arranque, el espacio en disco y la complejidad de la primera configuración superarían
con mucho el actual «doble clic en el APK y listo».

**A Waydroid además le falta compatibilidad ARM**: en x86 solo ejecuta apps x86; las apps que solo traen ARM
necesitan instalar aparte una capa de traducción `libhoudini`/`libndk`, y tras la traducción el rendimiento baja. Muchísimos APK de
video corto/redes sociales son solo arm64, y para un producto pensado para «el usuario suelta cualquier APK» eso es
un defecto grave.

## D. Tencent App Store para PC

Producto comercial de código cerrado, sin API pública: no se puede incrustar, ni distribuir con lo nuestro, ni garantizar que siga disponible.
**No viable.**

## E. Microsoft WSA

Microsoft terminó el soporte en marzo de 2025 y cerró el canal oficial de distribución; además depende de Hyper-V, que choca con
AEHD. Las versiones reempaquetadas por terceros tienen riesgos de cumplimiento. **No viable.**

## F. Cambiar de sistema operativo (FydeOS / PhoenixOS / Bliss OS)

Son **sistemas operativos completos**, no componentes para «ejecutar apps Android en Windows». Adoptarlos equivale a
pedir al usuario que reinstale el sistema, lo que choca de raíz con «doble clic en el APK en Windows y listo». Además
PhoenixOS prácticamente ya no se mantiene. **No es una dirección para el producto.**

## Recomendaciones

1. **Corto plazo**: el modo de ventana independiente (A) ya resolvió el principal problema de experiencia; primero pulirlo
   y observar la respuesta de los usuarios. Es el paso con mejor relación beneficio/coste.
2. **Medio plazo**: la capa de abstracción de bases intercambiables de `src/core/backends/` ya está lista (`Backend` +
   bits de capacidad `CAPS`); si algún día se integra Waydroid, basta con agregar una implementación de backend
   sin tocar el flujo principal.
3. **Si de verdad se hace Waydroid**, la única forma práctica es: **un instalador aparte / una rama aparte**,
   avisando claramente al usuario de que «esta versión necesita Hyper-V y no puede convivir con la versión de emulador», en vez de
   pretender cambiar sin cortes con la base actual.
