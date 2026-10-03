TARGET := iphone:clang:latest:15.0
ARCHS = arm64

# rootless (Dopamine / palera1n rootless / 侧载)
THEOS_PACKAGE_SCHEME = rootless

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = WarriorCheat
# 不再需要 fishhook.c（无文件 hook）
WarriorCheat_FILES = Tweak.x
WarriorCheat_CFLAGS = -fobjc-arc -Wno-deprecated-declarations -Wno-unused-variable -Wno-unused-function
WarriorCheat_FRAMEWORKS = UIKit Foundation CoreGraphics
WarriorCheat_LIBRARIES =

include $(THEOS_MAKE_PATH)/tweak.mk

after-install::
	install.exec "killall -9 BingoGame-mobile || true"
