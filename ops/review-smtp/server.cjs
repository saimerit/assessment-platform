// Local verification sink. No relay, no external delivery and no body storage.
const net=require('node:net'),http=require('node:http')
let mode='accept',connections=0,accepted=0,closed=0
net.createServer(socket=>{
 connections++;socket.on('error',()=>{});socket.on('close',()=>closed++)
 if(mode==='stall')return
 socket.write('220 review.invalid ESMTP\r\n')
 let buffer='',data=false
 socket.on('data',chunk=>{
  buffer+=chunk.toString()
  while(buffer.includes('\n')){
   const end=buffer.indexOf('\n'),line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1)
   if(data){if(line==='.') {data=false;accepted++;socket.write('250 Accepted locally\r\n')};continue}
   if(/^EHLO|^HELO/i.test(line))socket.write('250-review.invalid\r\n250 PIPELINING\r\n')
   else if(/^MAIL/i.test(line))socket.write(mode==='fail'?'451 Local simulated failure\r\n':'250 OK\r\n')
   else if(/^RCPT/i.test(line))socket.write(/\.(test|invalid)>$/i.test(line)?'250 OK\r\n':'550 Only synthetic recipients allowed\r\n')
   else if(/^DATA/i.test(line)){data=true;socket.write('354 End with dot\r\n')}
   else if(/^QUIT/i.test(line)){socket.end('221 Bye\r\n')}
   else socket.write('250 OK\r\n')
  }
 })
}).listen(2525,'0.0.0.0')
http.createServer((request,response)=>{
 if(request.method==='POST'&&request.url.startsWith('/mode/')){
  const next=request.url.slice('/mode/'.length);if(!['accept','fail','stall'].includes(next)){response.writeHead(400);response.end();return};mode=next
 }
 response.setHeader('Content-Type','application/json');response.end(JSON.stringify({mode,connections,accepted,closed}))
}).listen(8080,'0.0.0.0')
