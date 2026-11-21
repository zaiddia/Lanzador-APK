## Lanzador APK v0.7.3

Versión centrada en el **espacio en disco que ocupa Android**.

### Corrección principal

En Windows, el almacenamiento interno de Android ocupaba todo su tamaño en disco desde el primer inicio, aunque estuviera casi vacío. Es la partición de datos (`userdata-qemu.img`, de 4 a 16 GB según el espacio libre de tu disco). Por eso «desaparecían» más de 8 GB al abrir la app por primera vez.

- **Ahora es un archivo disperso:** solo ocupa en disco lo que Android escribe de verdad (apps, datos, partidas). Al instalar más apps crece poco a poco, hasta el tamaño configurado.
- **Instalaciones anteriores:** en el próximo arranque, Lanzador APK devuelve al disco los bloques que Android no usa. Puede tardar hasta un minuto la primera vez. Si no termina, sigue en el arranque siguiente.
- **No se pierde nada:** el contenido de la partición no cambia (solo se liberan bloques que están en cero), y si el emulador está usando el archivo, no se toca.
- **Instantáneas viejas:** se borran solas las copias de instantáneas que no se pudieron eliminar antes (`snapshots.stale-*`). Cada una pesaba lo mismo que la memoria de Android, de 2 a 8 GB.

### Qué sigue ocupando espacio (y es normal)

| Qué | Aprox. |
|---|---|
| Imagen del sistema Android descomprimida | 3–4 GB |
| Instantánea para abrir rápido (igual a la memoria asignada a Android) | 2–8 GB |
| Programa y runtime | ~1,5 GB |
| Apps y datos que instales | lo que ocupen |

Si te sobra poco disco, en Configuración → Rendimiento → «Memoria (MB)» puedes bajar la memoria de Android: la instantánea se achica en la misma medida.

Incluye también todo lo de la v0.7.2: barra de controles, «Cerrar todas las apps» y botones de navegación opcionales.
