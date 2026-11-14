import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {createStore} from '../backend/store';
import {encrypt,decrypt,parseKey,parseToken,safeUrl} from '../backend/security';
test('AES-GCM detects tampering and validates sensitive input',()=>{
 const key=parseKey(randomBytes(32).toString('hex'));const envelope=encrypt({access_token:'synthetic',refresh_token:'synthetic-refresh'},key);
 assert.equal(decrypt(envelope,key).access_token,'synthetic');
 assert.throws(()=>decrypt({...envelope,tag:Buffer.alloc(16).toString('base64')},key));
 assert.throws(()=>parseToken({access_token:''}));assert.throws(()=>safeUrl('javascript:alert(1)'));
});
test('real Postgres: add collisions, owner isolation, concurrent CAS, absent/null, patch removal, rollback',{skip:!process.env.DATABASE_URL},async()=>{
 const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
 try{await client.query('BEGIN');await client.query(await readFile(new URL('../migrations/001_records.sql',import.meta.url),'utf8'));
 const db=createStore((sql,values)=>client.query(sql,values));const id=randomUUID();
 assert.deepEqual(await db.tx.add('test_records',[{id,ownerId:'alice',revision:0,nullable:null,remove:'old'}]),[true]);
 assert.deepEqual(await db.tx.add('test_records',[{id,ownerId:'bob'}]),[false]);
 assert.deepEqual(await db.tx.update('test_records',[{id,record:{revision:1},if:{ownerId:'bob',revision:0}}],{patch:true}),[false]);
 const claims=await Promise.all([1,2].map(()=>db.tx.update('test_records',[{id,record:{revision:1},if:{ownerId:'alice',revision:0}}],{patch:true})));
 assert.equal(claims.flat().filter(Boolean).length,1);
 assert.deepEqual(await db.tx.update('test_records',[{id,record:{remove:undefined,hello:'world'},if:{nullable:null,missing:undefined}}],{patch:true}),[true]);
 const [record]=await db.get<Record<string,unknown>>('test_records',[id]);assert.equal(record!.hello,'world');assert.equal(Object.hasOwn(record!,'remove'),false);
 assert.deepEqual(await db.tx.update('test_records',[{id,record:{bad:true},if:{nullable:undefined}}],{patch:true}),[false]);
 assert.deepEqual(await db.tx.update('test_records',[{id,record:{ownerId:'alice',revision:2},if:{revision:1}}]),[true]);
 await db.tx.update('test_records',[{id:id+'new',record:{value:1}}]);
 await db.tx.update('test_records',[{id:id+'new',record:{value:2,missing:undefined}}],{patch:true});
 assert.deepEqual((await db.get('test_records',[id+'new','missing']))[0],{value:2});
 }finally{await client.query('ROLLBACK');await client.end();}
});
