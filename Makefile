TARGET := iphone:clang:latest:15.0
ARCHS = arm64

# rootless (Dopamine / palera1n rootless / TrollStore 侧载)
THEOS_PACKAGE_SCHEME = rootless

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = WarriorCheat
WarriorCheat_FILES = Tweak.x fishhook.c
WarriorCheat_CFLAGS = -fobjc-arc -Wno-deprecated-declarations -Wno-unused-variable -Wno-unused-function
WarriorCheat_FRAMEWORKS = UIKit Foundation CoreGraphics
# ⚠️ 侧载环境无 CydiaSubstrate/ellekit → 一律不链接 substrate，用内置 fishhook
WarriorCheat_LIBRARIES =

include $(THEOS_MAKE_PATH)/tweak.mk

after-install::
	install.exec "killall -9 BingoGame-mobile || true"
