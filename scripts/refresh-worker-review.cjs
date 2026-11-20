// Replace only the two review workers with their newly built images, preserving
// environment and loopback health ports. Broker/database/SMTP state stays intact.
const {readFileSync}=require('node:fs'),{join}=require('node:path'),{execFileSync}=require('node:child_process')
const root=join(__dirname,'..'),review=JSON.parse(readFileSync(join(root,'.attempt-access-review/latest.json'),'utf8'))
const workers=JSON.parse(readFileSync(join(review.directory,'worker-review.json'),'utf8'))
if(!/^assessment-auth-review-[a-f0-9]{12}$/.test(review.network))throw new Error('Requires isolated review network')
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim()
for(const [name,url,image] of [[workers.grader,workers.grader_url,review.grader_image],[workers.notification,workers.notification_url,`assessment-auth-review-notification:${review.suffix}-1d`]]){
 if(!name.startsWith(review.network+'-')||new URL(url).hostname!=='127.0.0.1')throw new Error('Unexpected worker replacement target')
 const before=JSON.parse(docker('inspect',name))[0]
 if(!before.NetworkSettings.Networks[review.network])throw new Error('Worker is outside the review network')
 docker('image','inspect',image)
 const args=['run','-d','--name',name,'--network',review.network,'-p',`127.0.0.1:${new URL(url).port}:8091`]
 for(const value of before.Config.Env)args.push('-e',value)
 args.push(image);docker('rm','-f',name);docker(...args)
 console.log('Updated review worker: '+name)
}
