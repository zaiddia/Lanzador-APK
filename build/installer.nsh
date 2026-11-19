; Script NSIS personalizado de LanzadorAPK
; Función: antes de desinstalar, termina los procesos del runtime que puedan seguir en segundo plano;
; si no, bloquean archivos de la carpeta de instalación y la desinstalación queda incompleta, ni siquiera las herramientas de borrado forzado pueden eliminarlos.
;
; Al cerrar LanzadorAPK puede quedar un qemu independiente (para abrir más rápido la próxima vez),
; así que el desinstalador tiene que limpiarlo por su cuenta.

; Al terminar la instalación: una capa extra para el icono del escritorio.
; createDesktopShortcut de electron-builder usa su propio flujo CreateShortcuts y
; en algunos entornos (escritorio redirigido a OneDrive, accesos revertidos por un programa de seguridad) falla,
; y el usuario no encuentra nada en el escritorio. Aquí se vuelve a crear con CreateShortcut nativo de NSIS:
; $DESKTOP usa SHGetFolderPath y sigue bien la redirección del escritorio; es idempotente,
; y si electron-builder también lo crea, solo se sobrescribe el mismo .lnk.
!macro customInstall
  DetailPrint "Creando el acceso directo en el escritorio…"
  CreateShortcut "$DESKTOP\LanzadorAPK.lnk" "$INSTDIR\LanzadorAPK.exe" "" "$INSTDIR\LanzadorAPK.exe" 0 \
    SW_SHOWNORMAL "" "Lanzador APK — Ejecuta apps Android en tu PC"
  CreateDirectory "$SMPROGRAMS\LanzadorAPK"
  CreateShortcut "$SMPROGRAMS\LanzadorAPK\LanzadorAPK.lnk" "$INSTDIR\LanzadorAPK.exe" "" "$INSTDIR\LanzadorAPK.exe" 0 \
    SW_SHOWNORMAL "" "Lanzador APK — Ejecuta apps Android en tu PC"
!macroend

!macro customUnInstall
  ; Primero se borran los accesos directos que creamos (aunque LanzadorAPK no esté instalado no deben quedar restos)
  Delete "$DESKTOP\LanzadorAPK.lnk"
  Delete "$SMPROGRAMS\LanzadorAPK\LanzadorAPK.lnk"
  RMDir "$SMPROGRAMS\LanzadorAPK"

  DetailPrint "Cerrando procesos de LanzadorAPK que siguen abiertos…"
  ; /F fuerza el cierre y /T incluye los procesos hijos. Si el proceso no existe taskkill devuelve 128; se ignora.
  nsExec::Exec 'taskkill.exe /F /T /IM LanzadorAPK.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-x86_64.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-i386.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator-check.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM adb.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM netsimd.exe'
  ; Se da un momento para que el proceso salga de verdad y libere los identificadores de archivo
  Sleep 1500
!macroend
