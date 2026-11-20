# platform.module-admin.standard

向控制台提供去实现细节的模块描述符、仓库装配列表和三 realm 解析结果。

数据在宿主完成读盘与预检后绑定；模块本身不扫描文件、不启动 provider、不保存草稿，也不允许热替换运行中的装配。
