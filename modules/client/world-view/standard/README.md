# client.world-view.standard

维护唯一一份玩家授权投影，负责 campaign 初始化、REST 重取、WebSocket 续传、开局和时钟控制。

命令仍经服务端网关；投影缺口会触发重新取快照，不能继续拼接旧增量。
