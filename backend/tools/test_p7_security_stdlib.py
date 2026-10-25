"""No installs. Actual storage/ASGI/handler bodies with injected FastAPI/DB ports.

Not an actual FastAPI/JWT/SQLAlchemy/MySQL integration test. Run the pytest file too.
"""
import ast
import asyncio
import copy
import importlib.util
import json
import os
import sys
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"


class HTTPException(Exception):
    def __init__(self, status_code, detail=None, headers=None):
        self.status_code, self.detail, self.headers = status_code, detail, headers
        super().__init__(detail)


class IntegrityError(Exception):
    pass


class OperationalError(Exception):
    pass


def module(name, relative):
    spec = importlib.util.spec_from_file_location(name, APP / relative)
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result


publish = module("p7_publish", "core/media_publish.py")
review = module("p7_review", "services/schedule_resource_review.py")


def injected(relative, values, *, handlers=False):
    tree = ast.parse((APP / relative).read_text())
    nodes = [ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)]
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith(("app.", "fastapi", "sqlalchemy", "pydantic")):
            continue
        if handlers and isinstance(node, ast.ClassDef):
            continue
        if handlers and isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "router" for t in node.targets):
            continue
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            node.decorator_list = []
            node.args.defaults = [ast.Constant(None) for _ in node.args.defaults]
        nodes.append(node)
    code = ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[]))
    env = {"HTTPException": HTTPException, "IntegrityError": IntegrityError, "OperationalError": OperationalError, **values}
    exec(compile(code, str(APP / relative), "exec"), env)
    return SimpleNamespace(**env)


def settings(root="."):
    return SimpleNamespace(
        MEDIA_ROOT=root, MEDIA_PUBLIC_PREFIX="/media", API_V1_PREFIX="/api/v1",
        UPLOAD_USER_PER_MINUTE=100, MEDIA_READ_USER_PER_MINUTE=100,
        MEDIA_USER_MAX_COUNT=1000, MEDIA_USER_MAX_BYTES=500 * 1024 * 1024,
        MEDIA_DISK_RESERVE_BYTES=1, API_IP_PER_MINUTE=240,
        REGISTER_IP_PER_HOUR=5, REGISTER_GLOBAL_PER_DAY=100,
        LOGIN_IP_PER_MINUTE=30, UPLOAD_IP_PER_MINUTE=20,
    )


class Field:
    def __init__(self, name): self.name = name
    def __eq__(self, value): return self.name, value


class Media(SimpleNamespace):
    id, user_id = Field("id"), Field("user_id")


class User:
    id = Field("user")


class Statement:
    def __init__(self, target): self.target, self.filters, self.locked = target, [], False
    def where(self, *conditions): self.filters.extend(conditions); return self
    def with_for_update(self): self.locked = True; return self
    def execution_options(self, **kwargs): return self
    def limit(self, n): self.maximum = n; return self


class DB:
    def __init__(self, rows=()):
        self.rows = {row.id: copy.copy(row) for row in rows}
        self.pending, self.statements, self.commits = None, [], 0
        self.fail_flush = self.fail_commit = False
    async def execute(self, statement):
        self.statements.append(statement)
        if statement.target is User.id:
            return SimpleNamespace(scalar_one_or_none=lambda: A)
        owner = dict(statement.filters).get("user_id")
        rows = [copy.copy(r) for r in self.rows.values() if r.user_id == owner]
        return SimpleNamespace(scalars=lambda: rows[:statement.maximum])
    async def scalar(self, statement):
        self.statements.append(statement)
        filters = dict(statement.filters)
        row = self.rows.get(filters["id"])
        return copy.copy(row) if row and ("user_id" not in filters or row.user_id == filters["user_id"]) else None
    def add(self, row): self.pending = row
    async def flush(self):
        if self.fail_flush: raise IntegrityError("duplicate")
    async def commit(self):
        if self.fail_commit: raise RuntimeError("lost COMMIT acknowledgement")
        self.commits += 1
        if self.pending: self.rows[self.pending.id] = self.pending
    async def refresh(self, row): row.created_at = "fixture"
    async def rollback(self): pass


A = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
B = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123457")
ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123458")
PNG = b"\x89PNG\r\n\x1a\npublic-fixture"
JPG = b"\xff\xd8\xffpublic-fixture"


def row(owner=A, ident=ID, thumb=False, size=1):
    return Media(id=ident, user_id=owner, entry_id=None, sort_order=0, width=None, height=None,
                 size=size, url=f"/media/{ident.hex[:4]}/{ident}.png",
                 thumb_url=f"/media/{ident.hex[:4]}/{ident}_thumb.png" if thumb else "",
                 created_at="fixture")


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = self.temp.name
        self.name = f"{ID}.png"; self.folder = ID.hex[:4]
    def tearDown(self): self.temp.cleanup()
    def put(self, data=PNG, **kw):
        return publish.publish_media(self.root, self.folder, {self.name: data},
                                     allow_existing=kw.get("allow", False), reserve_bytes=kw.get("reserve", 1))
    def test_atomic_creation_and_bytes(self):
        self.assertEqual(len(self.put()), 1)
        self.assertEqual((Path(self.root)/self.folder/self.name).read_bytes(), PNG)
    def test_different_bytes_cannot_replace(self):
        self.put()
        with self.assertRaises(FileExistsError): self.put(JPG, allow=True)
        self.assertEqual((Path(self.root)/self.folder/self.name).read_bytes(), PNG)
    def test_unknown_existing_cannot_be_adopted(self):
        self.put()
        with self.assertRaises(FileExistsError): self.put()
    def test_owned_same_bytes_are_idempotent(self):
        self.put(); self.assertEqual(self.put(allow=True), [])
    def test_rollback_only_our_new_files(self):
        created = self.put(); publish.discard_created(created)
        self.assertFalse((Path(self.root)/self.folder/self.name).exists())
    def test_cleanup_does_not_unlink_replaced_inode(self):
        created = self.put(); path=created[0][0]
        # Keep the old inode allocated, preventing inode-number reuse in this test.
        old = path.open("rb")
        try:
            path.unlink(); path.write_bytes(b"replacement")
            publish.discard_created(created); self.assertEqual(path.read_bytes(), b"replacement")
        finally: old.close()
    def test_concurrent_publish_has_one_winner(self):
        def attempt(data):
            try: self.put(data); return True
            except FileExistsError: return False
        with ThreadPoolExecutor(2) as pool: results=list(pool.map(attempt, [PNG,JPG]))
        self.assertEqual(sum(results), 1)
        self.assertIn((Path(self.root)/self.folder/self.name).read_bytes(), [PNG,JPG])
    def test_disk_reserve_failure_writes_no_media(self):
        with self.assertRaises(OSError): self.put(reserve=2**63)
        self.assertFalse((Path(self.root)/self.folder/self.name).exists())
    def test_symlink_folder_is_rejected(self):
        with tempfile.TemporaryDirectory() as outside:
            (Path(self.root)/self.folder).symlink_to(outside, target_is_directory=True)
            with self.assertRaises(OSError): self.put()
            self.assertEqual(list(Path(outside).iterdir()), [])
    def test_symlink_destination_is_rejected(self):
        directory=Path(self.root)/self.folder;directory.mkdir()
        target=Path(self.root)/"secret";target.write_bytes(PNG)
        (directory/self.name).symlink_to(target)
        with self.assertRaises(OSError): self.put(allow=True)
        self.assertEqual(target.read_bytes(), PNG)
    def test_second_file_conflict_leaves_first_unwritten(self):
        folder=Path(self.root)/self.folder;folder.mkdir()
        (folder/f"{ID}_thumb.png").write_bytes(b"occupied")
        with self.assertRaises(FileExistsError):
            publish.publish_media(self.root,self.folder,{self.name:PNG,f"{ID}_thumb.png":PNG},
                                  allow_existing=False,reserve_bytes=1)
        self.assertFalse((folder/self.name).exists())


class HandlerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.s=settings(self.temp.name)
        self.limiter=injected("core/request_limits.py",{}).AttemptLimiter()
        values={"settings":self.s,"attempt_limiter":self.limiter,"Media":Media,"User":User,
                "select":Statement,"ok":lambda data:data,"MediaResponse":lambda **kw:SimpleNamespace(**kw),
                "Response":lambda data,**kw:SimpleNamespace(data=data,**kw),
                "media_disk_paths":lambda *urls:[Path(self.temp.name)/u[len('/media/'):] for u in urls if u],
                "remove_media_paths":lambda paths:None,"get_current_user":None,"get_db":None,
                **{n:getattr(publish,n) for n in ['discard_created','publish_media','stored_file_size']},
                **{n:getattr(review,n) for n in ['probe_image','read_expected_image','stored_relative_path']}}
        self.h=injected("api/v1/media.py",values,handlers=True)
    def tearDown(self): self.temp.cleanup()
    def upload(self, db, data=PNG, ident=ID, thumb=None):
        file=SimpleNamespace(read=AsyncMock(return_value=data),content_type="image/png")
        thumb_file=SimpleNamespace(read=AsyncMock(return_value=thumb),content_type="image/png") if thumb else None
        return asyncio.run(self.h.upload_media(ident,file,thumb_file,None,0,None,None,SimpleNamespace(id=A),db))
    def seed(self, item=None, thumb=False):
        item=item or row(thumb=thumb)
        publish.publish_media(self.temp.name,item.id.hex[:4],{f"{item.id}.png":PNG},
                              allow_existing=False,reserve_bytes=1)
        return item
    def test_success_and_account_lock_first(self):
        db=DB();result=self.upload(db)
        self.assertEqual(result.id,ID);self.assertEqual(db.commits,1)
        self.assertIs(db.statements[0].target,User.id)
        self.assertTrue(db.statements[0].locked);self.assertTrue(db.statements[1].locked)
    def test_foreign_id_denied_before_file_reads(self):
        item=self.seed(row(owner=B));db=DB([item])
        with self.assertRaises(HTTPException) as caught:self.upload(db,JPG)
        self.assertEqual(caught.exception.status_code,404)
        self.assertEqual((Path(self.temp.name)/ID.hex[:4]/f"{ID}.png").read_bytes(),PNG)
    def test_precommit_constraint_failure_removes_our_files(self):
        db=DB();db.fail_flush=True
        with self.assertRaises(HTTPException) as caught:self.upload(db)
        self.assertEqual(caught.exception.status_code,409)
        self.assertFalse((Path(self.temp.name)/ID.hex[:4]/f"{ID}.png").exists())
    def test_uncertain_commit_retains_bytes_and_does_not_report_success(self):
        db=DB();db.fail_commit=True
        with self.assertRaises(HTTPException) as caught:self.upload(db)
        self.assertEqual(caught.exception.status_code,503)
        self.assertTrue((Path(self.temp.name)/ID.hex[:4]/f"{ID}.png").exists())
    def test_quota_ignores_forged_size_and_counts_thumbnail(self):
        item=self.seed(row(thumb=True,size=-999999))
        publish.publish_media(self.temp.name,ID.hex[:4],{f"{ID}_thumb.png":PNG},allow_existing=False,reserve_bytes=1)
        self.s.MEDIA_USER_MAX_BYTES=len(PNG)*2
        with self.assertRaises(HTTPException) as caught:self.upload(DB([item]),ident=B)
        self.assertEqual(caught.exception.status_code,413)
    def test_media_count_limit(self):
        self.s.MEDIA_USER_MAX_COUNT=1
        with self.assertRaises(HTTPException) as caught:self.upload(DB([row()]),ident=B)
        self.assertEqual(caught.exception.status_code,413)
    def test_original_private_owner_read(self):
        item=self.seed();result=asyncio.run(self.h.private_media(ID,"original",SimpleNamespace(id=A),DB([item])))
        self.assertEqual(result.data,PNG);self.assertEqual(result.headers['Cache-Control'],'private, no-store')
    def test_cross_user_read_is_404(self):
        item=self.seed()
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(self.h.private_media(ID,"original",SimpleNamespace(id=B),DB([item])))
        self.assertEqual(caught.exception.status_code,404)
    def test_missing_thumbnail_is_not_original(self):
        item=self.seed()
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(self.h.private_media(ID,"thumbnail",SimpleNamespace(id=A),DB([item])))
        self.assertEqual(caught.exception.status_code,404)
    def test_complete_record_with_symlink_cannot_report_uploaded(self):
        item=self.seed();path=Path(self.temp.name)/ID.hex[:4]/f"{ID}.png"
        target=Path(self.temp.name)/"secret";target.write_bytes(PNG)
        path.unlink();path.symlink_to(target)
        with self.assertRaises(HTTPException) as caught:self.upload(DB([item]))
        self.assertEqual(caught.exception.status_code,503)
        self.assertEqual(target.read_bytes(),PNG)
    def test_owned_complete_retry_does_not_replace(self):
        item=self.seed();db=DB([item]);self.upload(db,b"not a PNG")
        self.assertEqual(db.commits,0)
        self.assertEqual((Path(self.temp.name)/ID.hex[:4]/f"{ID}.png").read_bytes(),PNG)
    def test_existing_partial_different_bytes_cannot_overwrite(self):
        item=self.seed(row(thumb=True))
        with self.assertRaises(HTTPException) as caught:self.upload(DB([item]),PNG+b"different",thumb=PNG)
        self.assertEqual(caught.exception.status_code,409)
        self.assertEqual((Path(self.temp.name)/ID.hex[:4]/f"{ID}.png").read_bytes(),PNG)


class LimitTests(unittest.TestCase):
    def setUp(self):self.mod=injected('core/request_limits.py',{})
    def test_attempts_success_or_failure_are_counted(self):
        limiter=self.mod.AttemptLimiter()
        limiter.consume('register','ip',2,60,now=1);limiter.consume('register','ip',2,60,now=2)
        with self.assertRaises(HTTPException) as caught:limiter.consume('register','ip',2,60,now=3)
        self.assertEqual(caught.exception.headers['Retry-After'],'58')
        limiter.consume('register','ip',2,60,now=62)
    def test_active_entries_not_evicted_at_capacity(self):
        limiter=self.mod.AttemptLimiter(max_keys=1);limiter.consume('a','one',1,60,now=1)
        with self.assertRaises(HTTPException):limiter.consume('a','two',1,60,now=2)
        with self.assertRaises(HTTPException):limiter.consume('a','one',1,60,now=2)
        limiter.consume('a','two',1,60,now=62)
        self.assertEqual(len(limiter._buckets),1)
    def test_older_login_limiter_does_not_allocate_on_check(self):
        old=injected('core/rate_limit.py',{}).LoginRateLimiter()
        for i in range(20000):old.check(str(i),now=1)
        self.assertEqual(len(old._failures),0)


class MiddlewareTests(unittest.TestCase):
    def setUp(self):
        self.s=settings();self.limiter=injected('core/request_limits.py',{}).AttemptLimiter()
        self.mod=injected('core/abuse_middleware.py',{'settings':self.s,'attempt_limiter':self.limiter})
    def request(self,path,method='POST',body=b'',headers=(),ip='test-ip',consumer=None):
        messages=[];called=[]
        async def app(scope,receive,send):
            called.append(True)
            if consumer: await consumer(receive)
            await send({'type':'http.response.start','status':200,'headers':[]})
            await send({'type':'http.response.body','body':b'ok'})
        async def receive():return {'type':'http.request','body':body,'more_body':False}
        async def send(message):messages.append(message)
        asyncio.run(self.mod.AbuseMiddleware(app)({'type':'http','path':path,'method':method,'client':(ip,1),'headers':headers},receive,send))
        return messages,called
    def test_legacy_path_never_reaches_app(self):
        for path in ['/media','/media/','/media/private.png']:
            messages,called=self.request(path,'GET');self.assertFalse(called)
            self.assertEqual(messages[0]['status'],404)
    def test_register_limited_before_body_or_handler(self):
        self.s.REGISTER_IP_PER_HOUR=1
        self.assertEqual(self.request('/api/v1/auth/register')[0][0]['status'],200)
        messages,called=self.request('/api/v1/auth/register/')
        self.assertFalse(called);self.assertEqual(messages[0]['status'],429)
        self.assertEqual(json.loads(messages[1]['body'])['code'],429)
    def test_raw_forwarded_header_does_not_change_key(self):
        self.s.REGISTER_IP_PER_HOUR=1
        self.request('/api/v1/auth/register',headers=[(b'x-forwarded-for',b'1.2.3.4')])
        self.assertEqual(self.request('/api/v1/auth/register',headers=[(b'x-forwarded-for',b'5.6.7.8')])[0][0]['status'],429)
    def test_global_registration_bound_covers_different_ips(self):
        self.s.REGISTER_GLOBAL_PER_DAY=1;self.request('/api/v1/auth/register',ip='one')
        self.assertEqual(self.request('/api/v1/auth/register',ip='two')[0][0]['status'],429)
    def test_private_cache_header_on_any_status(self):
        messages,_=self.request('/api/v1/media/id/original','GET')
        headers=dict(messages[0]['headers']);self.assertEqual(headers[b'cache-control'],b'private, no-store')
        self.assertEqual(headers[b'vary'],b'Authorization')
    def test_content_length_overflow_before_consumer(self):
        messages,called=self.request('/api/v1/media/id',headers=[(b'content-length',b'999999999')])
        self.assertEqual(messages[0]['status'],413);self.assertFalse(called)
    def test_stream_overflow_has_413_without_content_length(self):
        self.mod.AbuseMiddleware.__call__.__globals__['MAX_BODY']=3
        async def consume(receive):await receive()
        messages,_=self.request('/api/v1/media/id',body=b'four',consumer=consume)
        self.assertEqual(messages[0]['status'],413)
    def test_login_successes_also_limited(self):
        self.s.LOGIN_IP_PER_MINUTE=1;self.request('/api/v1/auth/login')
        self.assertEqual(self.request('/api/v1/auth/login')[0][0]['status'],429)


if __name__ == '__main__':unittest.main(verbosity=2)
