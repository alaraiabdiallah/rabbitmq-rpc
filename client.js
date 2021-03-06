const amqp = require('amqplib');
const { v4: uuid } = require('uuid');
class Client {
    _initProps() {
        this._uri_connect = null;
        this._connection = null;
        this._channel = null;
        this._exchange = {
            name: "rpc",
        };
        this._queue = null;
        this._timeout = 5000;
        this._retry = 3
    }
    constructor({uri_connect, exchange, timeout}){
        this._initProps()
        this._uri_connect = uri_connect || this._uri_connect;
        this._exchange = exchange || this._exchange;
        this._timeout = timeout || this._timeout;
    }

    async makeConnection(){
        this._connection = await amqp.connect(this._uri_connect);
        this._channel = await this._connection.createChannel();
        this._queue = await this._channel.assertQueue('', {exclusive: true});
    } 

    async _response(correlationId) {
        return new Promise(async (resolve, reject) => {
            try {
                const {queue: queue_name} = this._queue;
                return await this._channel.consume(queue_name, function(msg) {
                    if (msg != null && msg.properties.correlationId == correlationId) resolve(msg.content.toString());
                }, { noAck: true });
            } catch (error) {
                return reject(error);
            }
        });
    }


    async _getResponse(correlationId, timeout){
        try{
            let wait;
            let _promiseTimeout = new Promise((resolve, reject) => {
                wait = setTimeout(()=> {
                    resolve({timeout: true});
                },timeout)
            })
            const response =  await Promise.race([
                this._response(correlationId),
                _promiseTimeout,
            ]);
            if(response && response.timeout) throw Error("Request timeout");
            clearTimeout(wait);
            return Promise.resolve(response);
        }catch (error) {
            return Promise.reject(error);
        }
        
    }

    async publish(route, string_body, options, tries = 1) {
        let timeout = (options.timeout || this._timeout) * (tries * tries);
        let retry = options.retry || this._retry;
        try {
            const {name: exchange_name} = this._exchange;
            const {queue: queue_name} = this._queue;
            const correlationId = uuid();
            // console.log(`Queue name : ${queue_name}`);
            await this._channel.publish(exchange_name, route, Buffer.from(string_body), { correlationId, replyTo: queue_name, contentType: "text/plain" });
            const response = await this._getResponse(correlationId, timeout);
            await this._channel.deleteQueue(queue_name);
            await this.close();
            return Promise.resolve(response);    
        } catch (error) {
            await this.close();
            return tries <= retry ? this.publish(route, string_body, options, tries + 1) : Promise.reject(error);
        }
          
    }

    async close() {
        await this._connection.close();
    }
}
module.exports = async function(params) {
    const client = new Client(params);
    await client.makeConnection();
    return client;
}