; 随身 · NSIS 自定义安装逻辑
; 默认快捷方式保持原样；另建一个"兼容模式"快捷方式，带上已验证能
; 绕过 GPU/沙箱初始化崩溃的两个开关。用户先用普通方式，不行再用兼容模式。

!macro customInstall
  CreateShortCut "$DESKTOP\随身（兼容模式）.lnk" "$INSTDIR\随身.exe" "--no-sandbox --disable-gpu" "$INSTDIR\随身.exe" 0
  CreateShortCut "$SMPROGRAMS\随身（兼容模式）.lnk" "$INSTDIR\随身.exe" "--no-sandbox --disable-gpu" "$INSTDIR\随身.exe" 0
  CopyFiles /SILENT "$INSTDIR\resources\compat-launcher.bat" "$INSTDIR\compat-launcher.bat"
!macroend
