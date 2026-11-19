## Lanzador APK v0.7.0

Primera versión de **Lanzador APK**: ejecuta apps Android en Windows, cada una en su propia ventana y con su icono en el escritorio. Es una adaptación del proyecto original apkstart, con la interfaz en español, sin servicios chinos y con más seguridad.

### Descargas

| Archivo | Para quién |
|---|---|
| `LanzadorAPK-v0.7.0-win64-portable.zip` | **Versión ligera (~100 MB).** Descomprime y ejecuta `LanzadorAPK.exe`. En el primer inicio descarga el runtime de Android (~1,4 GB). |
| `LanzadorAPK-0.7.0-Setup.exe` | **Versión completa (~1,3 GB).** Instalador con el runtime incluido; funciona sin internet tras instalar. |
| `LanzadorAPK-runtime-v0.7.0.zip` | Paquete del runtime que descarga la versión ligera (no hace falta bajarlo a mano). |
| `SHA256SUMS.txt` | Sumas SHA-256 de todos los archivos, para verificar la descarga. |

> Los archivos de la versión completa tardan alrededor de una hora más en aparecer que la versión ligera, porque se compilan aparte.

### Novedades frente al original

- Interfaz, mensajes, comentarios del código y documentación en **español**.
- Android arranca en **español (Latinoamérica)** y con la zona horaria de tu PC.
- Se quitó el teclado chino Pinyin; se usa el **teclado latino** de Android. Para la ñ y las tildes del teclado de tu PC: Configuración → **Teclado físico** → «Español (Latinoamérica)».
- Descargas y actualizaciones **solo desde GitHub**, verificadas con **SHA-256** (y SHA-1 para los componentes de Google). Se quitaron Gitee, los espejos chinos y npmmirror.
- La comprobación de conexión de Android usa los servidores de Google en lugar de los de Xiaomi.
- Corrección en la matriz de reintentos de arranque para equipos con poca memoria.

### Requisitos

- Windows 10/11 de 64 bits, 8 GB de RAM recomendados.
- Virtualización activada (VT-x / SVM en la BIOS) y la «Plataforma del hipervisor de Windows» para ir rápido; sin ella funciona con emulación por software, más lenta.

### Aviso

Los archivos no están firmados digitalmente: Windows SmartScreen puede mostrar «Windows protegió tu PC». Pulsa **Más información → Ejecutar de todas formas**.
