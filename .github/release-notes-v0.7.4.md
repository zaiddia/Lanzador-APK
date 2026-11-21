## Lanzador APK v0.7.4

Corrección: **la barra de controles no aparecía** junto a la ventana de la app. Es la barra con Atrás, Inicio, Apps abiertas, Captura, Girar, Pantalla completa, Minimizar y Cerrar la app.

### Qué pasaba

La barra solo se mostraba cuando la ventana del emulador tenía el foco de Windows. Pero al abrir una app desde el escritorio o el menú Inicio, Windows no le da el foco al emulador hasta que haces clic dentro. Además, el foco a veces queda en otra ventana del propio emulador. En la práctica, la barra casi nunca llegaba a mostrarse.

### Qué cambia

- La barra aparece en cuanto la ventana de la app está a la vista, sin necesidad de hacer clic, y se sigue ocultando cuando otra ventana la tapa.
- El foco se reconoce por proceso, así cuenta aunque esté en cualquier ventana del emulador.
- La barra ya no usa transparencia, que en algunos equipos no se dibujaba.
- En `app.log` queda registrado por qué la barra está visible u oculta. Si en tu equipo sigue sin verse, el informe de diagnóstico dirá la causa.

Mientras tanto, la app abierta también se puede cerrar desde el icono de la bandeja → «Cerrar la aplicación actual» o «Cerrar todas las apps de Android».
