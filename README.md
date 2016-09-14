##openwebrtc编译指南

**openwebrtc是一个用于移动平台实现webrtc标准接口的一套框架.他的原理是通过将webrtc接口js注入到浏览器执行native通过c与系统进行调用来实现webrtc在webkit或者说webview的正常运行.**

**openwebrtc编译的源码非常大,因为他针对了很多平台,引用的库也十分多,这是造成他工程目录大的原因之一,此外他针对不同的architecture回编译成不同的动态库, 光ios平台就有armv7 armv7s arm64 模拟器的x86等多个平台 ,因此你要预留10G以上的HDD空间来.**

####首先讲一下编译的过程,openwebrtc使用cerbero编译	    [OpenWebRTC](https://github.com/EricssonResearch/cerbero)

    1.osx host编译 没问题 直接编译链接
    2.ios平台编译期间会报错 直接3 enter 跳过 是glib报错 不用问 编译结束 安装 ~/cerbero/openwebrtc-devel-0.3.0-ios-universal.pkg 
      会输出framework到~/Library/Developer/OpenWebRTC/iPhoneOS.sdk/下面
    3.因为每次编译都会compare和git上的版本号 发现不同就会更新到最新版本所以建议通过修改git地址来修改
      编译代码,通过修改/cerbero/recipts/openwebrtc.recipe 文件中的git地址来修改源码