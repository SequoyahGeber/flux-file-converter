const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fail } = require('./security.cjs');
const DAY = 24 * 60 * 60 * 1000;
async function createAccess({ storage, ownerEmail, origin, now = Date.now }) {
  if(typeof ownerEmail!=='string'||!/^\S+@\S+\.\S+$/.test(ownerEmail))throw new Error('An owner email is required for invitation management.');
  ownerEmail=ownerEmail.toLowerCase();
  const file=path.join(storage,'access.json');let state={version:1,members:[],invites:[]}, serial=Promise.resolve();
  try {
    const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1_000_000)throw new Error('Invalid access database.');
    state=JSON.parse(await fs.readFile(file,'utf8'));
    if(state.version!==1||!Array.isArray(state.members)||state.members.length>49||!Array.isArray(state.invites)||state.invites.length>100)throw new Error('Invalid access database.');
    for(const m of state.members)if(!/^[a-f0-9]{64}$/.test(m.id)||typeof m.email!=='string'||!Number.isFinite(m.joinedAt))throw new Error('Invalid member record.');
    for(const i of state.invites)if(!/^[a-f0-9-]{36}$/.test(i.id)||!Number.isFinite(i.expiresAt)||!/^[a-f0-9]{64}$/.test(i.hash))throw new Error('Invalid invitation record.');
  } catch(e) { if(e.code!=='ENOENT')throw e; }
  const isOwner=user=>user.email.toLowerCase()===ownerEmail;
  const allowed=user=>isOwner(user)||state.members.some(m=>m.id===user.id);
  const admin=user=>{if(!isOwner(user))throw fail('Only the owner can manage invitations.',403);};
  async function update(change) {
    const next=serial.then(async()=>{
      const copy=structuredClone(state), result=change(copy), temporary=file+'.'+crypto.randomUUID()+'.tmp';
      let handle;
      try {
        handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(copy));await handle.sync();await handle.close();handle=null;
        await fs.rename(temporary,file);state=copy;return result;
      } finally { await handle?.close();await fs.rm(temporary,{force:true}); }
    });
    serial=next.catch(()=>{});return next;
  }
  function list(user) {
    admin(user);return {members:state.members,invites:state.invites.map(({hash,...i})=>({...i,status:i.revokedAt?'revoked':i.claimedAt?'claimed':now()>=i.expiresAt?'expired':'pending'}))};
  }
  async function invite(user) {
    admin(user);
    const token=crypto.randomBytes(32).toString('base64url'), hash=crypto.createHash('sha256').update(token).digest('hex');
    return update(copy=>{
      if(copy.members.length>=49)throw fail('The member limit has been reached.',409);
      copy.invites=copy.invites.filter(i=>!i.claimedAt&&!i.revokedAt&&i.expiresAt>now());
      if(copy.invites.length>=20)throw fail('You already have 20 pending invitations. Revoke one first.',429);
      const id=crypto.randomUUID(),createdAt=now(),expiresAt=createdAt+DAY;
      copy.invites.push({id,hash,createdAt,expiresAt});
      return {id,expiresAt,url:origin+'/?invite='+token};
    });
  }
  async function claim(user,token) {
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw fail('This invitation is invalid or expired.',410);
    // Existing members must not accidentally consume a link meant for a guest.
    if(allowed(user))return {alreadyMember:true};
    const hash=crypto.createHash('sha256').update(token).digest('hex');
    return update(copy=>{
      const invitation=copy.invites.find(i=>i.hash===hash&&!i.claimedAt&&!i.revokedAt&&i.expiresAt>now());
      if(!invitation)throw fail('This invitation is invalid, expired, or already used.',410);
      if(copy.members.some(m=>m.id===user.id))return {alreadyMember:true};
      if(copy.members.length>=49)throw fail('The member limit has been reached.',409);
      const joinedAt=now();copy.members.push({id:user.id,email:user.email,joinedAt});
      invitation.claimedAt=joinedAt;invitation.claimedBy=user.email;
      return {joined:true};
    });
  }
  async function revokeInvite(user,id) {
    admin(user);return update(copy=>{const item=copy.invites.find(i=>i.id===id);if(!item)throw fail('Invitation not found.',404);item.revokedAt=now();return {ok:true};});
  }
  async function revokeMember(user,id) {
    admin(user);return update(copy=>{const i=copy.members.findIndex(m=>m.id===id);if(i<0)throw fail('Member not found.',404);copy.members.splice(i,1);return {ok:true};});
  }
  return {isOwner,allowed,list,invite,claim,revokeInvite,revokeMember};
}
module.exports={createAccess};
