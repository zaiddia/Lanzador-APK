'use strict';
/**
 * Validación de nombres de paquete Android.
 *
 * El nombre de paquete viene del AndroidManifest.xml del APK (entrada externa), pero se usa directamente para armar rutas de archivos locales
 * (store.iconPath / apkPath) y comandos de adb shell (pm path / pidof / am start…).
 * Sin validarlo, se entregarían «../», letras de unidad y metacaracteres de shell directamente a path.join y a la shell:
 * lo primero escribe fuera de la carpeta de destino, lo segundo permite inyección de comandos.
 *
 * La restricción real de los nombres de paquete Android: varios segmentos separados por puntos, cada uno empieza con letra/guion bajo,
 * seguido de letras/números/guiones bajos. Aquí se valida estrictamente en ASCII: mejor rechazar unos pocos paquetes raros
 * de terceros que dejar pasar un solo separador de ruta o carácter de shell.
 */
const RE_PKG = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

function validPackageName(pkg) {
  return typeof pkg === 'string' && RE_PKG.test(pkg);
}

/** Convierte un nombre de paquete inválido en un nombre de archivo seguro (para registros/mostrar como respaldo, no para instalar) */
function safeFilePart(pkg) {
  if (validPackageName(pkg)) return pkg;
  return `invalid-${String(pkg || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}`;
}

module.exports = { validPackageName, safeFilePart, RE_PKG };
