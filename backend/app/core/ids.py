import uuid

import uuid_utils

def new_id() -> uuid.UUID:
    """生成 UUID v7。注意：业务主键正常由客户端生成，这里主要给测试和服务端建的记录用。"""
    return uuid.UUID(str(uuid_utils.uuid7()))
