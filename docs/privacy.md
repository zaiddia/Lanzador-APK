# Política de privacidad de Lanzador APK

Última actualización: 2026-11-18

Lanzador APK es un ejecutor de apps Android que funciona en tu propio equipo. **No recopila, no envía y no comparte tus datos personales.**

## Lo que no recopila

- No tiene sistema de cuentas: no pide nombre, correo ni teléfono.
- No recopila identificadores del dispositivo, ID de publicidad ni ubicación.
- No incluye SDK de analítica, telemetría, informes de fallos ni publicidad.
- No envía datos a ningún servidor propio (no tiene servidor).

## Datos guardados en tu equipo

| Ubicación | Contenido |
|---|---|
| `%APPDATA%\lanzadorapk` (versión de la Store: `%USERPROFILE%\LanzadorAPK\data`) | Configuración, apps instaladas, iconos e imagen/datos de Android (salvo que cambies la carpeta en Configuración) |
| `%USERPROFILE%\LanzadorAPKShared` | Carpeta compartida con `/sdcard/LanzadorAPKShared` dentro de Android |

Desinstalar el programa no borra estas carpetas; puedes borrarlas a mano cuando quieras.

## Conexiones a internet

- **Buscar actualizaciones:** consulta la lista de versiones en GitHub (`api.github.com` / `github.com`) y descarga desde allí.
- **Versión portátil ligera:** la primera vez descarga el runtime desde las Releases de GitHub del proyecto o, si no está disponible, desde el repositorio oficial de Google (`dl.google.com`).
- **Comprobación de conexión de Android:** usa el servidor estándar de Google (`connectivitycheck.gstatic.com`).
- Las solicitudes solo incluyen el número de versión y las cabeceras HTTP normales.
- El tráfico de las apps Android que instales depende de cada app; Lanzador APK no lo inspecciona ni lo guarda.

## Terceros

Las apps Android que ejecutes con Lanzador APK son de sus respectivos desarrolladores y se rigen por sus propias políticas de privacidad.

## Cambios

Si esta política cambia, se actualizará esta página y la fecha de arriba. Para dudas, abre un issue en https://github.com/zaiddia/Lanzador-APK/issues
