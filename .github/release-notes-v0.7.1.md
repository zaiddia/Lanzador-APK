## Lanzador APK v0.7.1

Versión centrada en el **espacio en disco**: menos errores confusos del runtime cuando el disco se llena, y menos espacio usado.

### Mejoras

- **Comprobación de espacio antes de descomprimir la imagen de Android** (unos 3,3 GB en el primer arranque). Si no alcanza, ahora se muestra un mensaje claro con cuánto hace falta, cuánto queda y dónde cambiarlo, en vez de un error técnico (`ENOSPC`) que parecía una falla del runtime.
- **Propuesta de otro disco en el primer inicio**: si C: tiene poco espacio y hay otro disco con bastante más, Lanzador APK pregunta (una sola vez) si quieres guardar ahí los datos de Android y el runtime. Si dices que no, todo sigue igual.
- **La «Carpeta de datos de Android» de la configuración ahora se respeta siempre.** Antes, en la versión ligera, se ignoraba y los datos seguían ocupando C:. Si ya tenías apps instaladas, se siguen usando desde la ubicación anterior hasta que muevas la carpeta `lanzadorapk.avd`.
- **Versión ligera más liviana en disco**: tras descomprimir la imagen del sistema se borra la copia comprimida descargada (se liberan alrededor de 1 GB). En el instalador completo la copia se conserva, porque es la que permite recuperar la imagen sin internet.
- Si no hay espacio, la instalación automática se detiene con el motivo real en vez de intentar descargar otra vez desde la fuente oficial.
- Los avisos de espacio distinguen entre **el disco de tu PC** (indicando la unidad) y **el almacenamiento interno de Android**.

### Descargas

| Archivo | Para quién |
|---|---|
| `LanzadorAPK-v0.7.1-win64-portable.zip` | Versión ligera (~100 MB). Descarga el runtime de Android en el primer inicio. |
| `LanzadorAPK-0.7.1-Setup.exe` | Versión completa (~1,3 GB) con el runtime incluido. Al instalar puedes elegir otro disco. |
| `LanzadorAPK-runtime-v0.7.1.zip` | Paquete del runtime que usa la versión ligera. |
| `SHA256SUMS.txt` | Sumas SHA-256 para verificar las descargas. |

### Espacio necesario

Unos **12–15 GB libres** en total: programa y runtime (~5 GB) + datos de Android (4–8 GB) + instantánea de arranque rápido (2–4 GB). Si C: va justo, usa otro disco en Configuración → Integración con el sistema.
