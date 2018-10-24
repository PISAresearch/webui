import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, NgZone } from '@angular/core';
import { from, Observable, of, throwError, zip } from 'rxjs';
import { fromPromise } from 'rxjs/internal-compatibility';
import { catchError, first, flatMap, map, shareReplay, switchMap, tap, toArray } from 'rxjs/operators';
import { Block } from 'web3/eth/types';
import { Channel } from '../models/channel';
import { Connections } from '../models/connection';
import { Event, EventsParam } from '../models/event';
import { PaymentEvent } from '../models/payment-event';
import { SwapToken } from '../models/swaptoken';
import { UserToken } from '../models/usertoken';
import { amountFromDecimal, amountToDecimal } from '../utils/amount.converter';
import { EnvironmentType } from './enviroment-type.enum';
import { RaidenConfig } from './raiden.config';
import { SharedService } from './shared.service';
import { TokenInfoRetrieverService } from './token-info-retriever.service';

export type CallbackFunc = (error: Error, result: any) => void;

@Injectable({
    providedIn: 'root'
})
export class RaidenService {

    readonly raidenAddress$: Observable<string>;
    private userTokens: { [id: string]: UserToken | null } = {};

    constructor(
        private http: HttpClient,
        private zone: NgZone,
        private raidenConfig: RaidenConfig,
        private sharedService: SharedService,
        private tokenInfoRetriever: TokenInfoRetrieverService
    ) {
        this.raidenAddress$ = this.http.get<{ our_address: string }>(`${this.raidenConfig.api}/address`).pipe(
            map((data) => this._raidenAddress = data.our_address),
            catchError((error) => this.handleError(error)),
            shareReplay(1)
        );
    }

    public get production(): boolean {
        return this.raidenConfig.config.environment_type === EnvironmentType.PRODUCTION;
    }

    private _raidenAddress: string;

    public get raidenAddress(): string {
        return this._raidenAddress;
    }

    // noinspection JSMethodCanBeStatic
    get identifier(): number {
        return Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);
    }

    getBlockNumber(): Observable<number> {
        return fromPromise(this.raidenConfig.web3.eth.getBlockNumber());
    }

    public checkChecksumAddress(address: string): boolean {
        return this.raidenConfig.web3.utils.checkAddressChecksum(address);
    }

    public toChecksumAddress(address: string): string {
        return this.raidenConfig.web3.utils.toChecksumAddress(address);
    }

    public getChannels(): Observable<Array<Channel>> {
        let tokens$: Observable<any>;
        if (Object.keys(this.userTokens).length === 0) {
            tokens$ = this.getTokens(true);
        } else {
            tokens$ = of(null);
        }

        const fetchChannels = this.http.get<Array<Channel>>(`${this.raidenConfig.api}/channels`).pipe(
            flatMap((channels: Array<Channel>) => from(channels)),
            map((channel: Channel) => {
                channel.userToken = this.getUserToken(channel.token_address);
                return channel;
            }),
            toArray(),
            catchError((error) => this.handleError(error)),
        );

        return tokens$.pipe(flatMap(() => fetchChannels));
    }

    public getTokens(refresh: boolean = false): Observable<Array<UserToken>> {
        const tokens$: Observable<{ [address: string]: UserToken }> = this.http.get<Array<string>>(`${this.raidenConfig.api}/tokens`)
            .pipe(flatMap(tokenAddresses => fromPromise(this.tokenInfoRetriever.createBatch(tokenAddresses, this._raidenAddress))));
        const connections$ = refresh ?
            this.http.get<Connections>(`${this.raidenConfig.api}/connections`) :
            of(null);

        return zip(tokens$, connections$).pipe(map(([userTokens, connections]) => {
            Object.keys(userTokens).forEach(address => {
                const token = userTokens[address];
                if (connections) {
                    token.connected = connections[address];
                }

                const cachedToken = this.userTokens[address];
                if (cachedToken) {
                    this.userTokens[address] = Object.assign(cachedToken, token);
                } else {
                    this.userTokens[address] = token;
                }
            });

            return Object.values(this.userTokens);
        }));
    }


    public getChannel(tokenAddress: string, partnerAddress: string): Observable<Channel> {
        return this.http.get<Channel>(
            `${this.raidenConfig.api}/channels/${tokenAddress}/${partnerAddress}`,
        ).pipe(
            catchError((error) => this.handleError(error)),
        );
    }

    public openChannel(
        tokenAddress: string,
        partnerAddress: string,
        settleTimeout: number,
        balance: number,
        decimals: number
    ): Observable<Channel> {
        const data = {
            'token_address': tokenAddress,
            'partner_address': partnerAddress,
            'settle_timeout': settleTimeout,
            'total_deposit': amountFromDecimal(balance, decimals),
        };
        return this.http.put<Channel>(`${this.raidenConfig.api}/channels`, data).pipe(
            catchError((error) => this.handleError(error)),
        );
    }

    public initiatePayment(
        tokenAddress: string,
        targetAddress: string,
        amount: number,
        decimals: number
    ): Observable<any> {
        const raidenAmount = amountFromDecimal(amount, decimals);

        return this.http.post(
            `${this.raidenConfig.api}/payments/${tokenAddress}/${targetAddress}`,
            {
                amount: raidenAmount,
                identifier: this.identifier
            },
        ).pipe(
            tap((response) => {
                if ('target_address' in response && 'identifier' in response) {
                    const formattedAmount = amount.toFixed(decimals).toString();
                    this.sharedService.success({
                        title: 'Transfer successful',
                        description: `A payment of ${formattedAmount} was successfully sent to the partner ${targetAddress}`
                    });
                } else {
                    this.sharedService.error({
                        title: 'Payment error',
                        description: JSON.stringify(response),
                    });
                }
            }),
            catchError((error) => this.handleError(error)),
        );
    }

    public getPaymentHistory(tokenAddress: string, targetAddress?: string): Observable<PaymentEvent[]> {
        return this.http.get<PaymentEvent[]>(`${this.raidenConfig.api}/payments/${tokenAddress}`)
            .pipe(
                map(events => {
                    if (targetAddress) {
                        return events.filter(event => event.initiator === targetAddress || event.target === targetAddress);
                    } else {
                        return events;
                    }
                }),
                catchError((error) => this.handleError(error))
            );
    }

    public depositToChannel(
        tokenAddress: string,
        partnerAddress: string,
        amount: number,
        decimals: number
    ): Observable<Channel> {

        const depositIncrement = amountFromDecimal(amount, decimals);

        return this.getChannel(tokenAddress, partnerAddress).pipe(
            switchMap((channel) => this.http.patch<Channel>(
                `${this.raidenConfig.api}/channels/${tokenAddress}/${partnerAddress}`,
                {total_deposit: channel.total_deposit + depositIncrement},
            )),
            tap((response) => {
                const action = 'Deposit';
                if ('balance' in response && 'state' in response) {
                    const balance = amountToDecimal(response.balance, decimals);
                    const formattedBalance = balance.toFixed(decimals).toString();
                    this.sharedService.info({
                        title: action,
                        description: `The channel ${response.channel_identifier} has been modified with a deposit of ${formattedBalance}`
                    });
                } else {
                    this.sharedService.error({
                        title: action,
                        description: JSON.stringify(response)
                    });
                }
            }),
            catchError((error) => this.handleError(error)),
        );
    }

    public closeChannel(tokenAddress: string, partnerAddress: string): Observable<Channel> {
        return this.http.patch<Channel>(
            `${this.raidenConfig.api}/channels/${tokenAddress}/${partnerAddress}`,
            {state: 'closed'},
        ).pipe(
            tap(response => {
                const action = 'Close';
                if ('state' in response && response.state === 'closed') {
                    this.sharedService.info({
                        title: action,
                        description: `The channel ${response.channel_identifier} with partner
                    ${response.partner_address} has been closed successfully`
                    });
                } else {
                    this.sharedService.error({
                        title: action,
                        description: JSON.stringify(response)
                    });
                }
            }),
            catchError((error) => this.handleError(error)),
        );
    }

    public registerToken(tokenAddress: string): Observable<UserToken> {
        return this.http.put(
            `${this.raidenConfig.api}/tokens/${tokenAddress}`,
            {},
        ).pipe(
            map(() => {
                const userToken = this.getUserToken(tokenAddress);
                if (userToken === null) {
                    throw new Error(`No contract on address: ${tokenAddress}`);
                }
                return userToken;
            }),
            tap((userToken: UserToken) => {
                this.sharedService.success({
                    title: 'Token registered',
                    description: `Your token was successfully registered: ${userToken.address}`
                });
            }),
            catchError((error) => this.handleError(error))
        );
    }

    public connectTokenNetwork(funds: number, tokenAddress: string, decimals: number): Observable<any> {
        return this.http.put(
            `${this.raidenConfig.api}/connections/${tokenAddress}`,
            {funds: amountFromDecimal(funds, decimals)},
        ).pipe(
            tap(() => {
                this.sharedService.success({
                    title: 'Joined Token Network',
                    description: `You have successfully joined the Network of Token ${tokenAddress}`
                });
            }),
            catchError((error) => this.handleError(error)),
        );
    }

    public leaveTokenNetwork(userToken: UserToken): Observable<any> {
        return this.http.delete(`${this.raidenConfig.api}/connections/${userToken.address}`).pipe(
            map(() => true),
            tap(() => {
                const description = `Successfully closed and settled all channels in ${userToken.name} <${userToken.address}> token`;
                this.sharedService.success({
                    title: 'Left Token Network',
                    description: description,
                });
            }),
            catchError((error) => this.handleError(error)),
        );
    }

    public getBlockchainEvents(
        eventsParam: EventsParam,
        fromBlock?: number,
        toBlock?: number,
    ): Observable<Array<Event>> {
        let path: string;
        const channel = eventsParam.channel;
        const basePath = '_debug/blockchain_events';

        if (channel) {
            path = `${basePath}/payment_networks/${channel.token_address}/channels/${channel.partner_address}`;
        } else if (eventsParam.token) {
            path = `${basePath}/tokens/${eventsParam.token}`;
        } else {
            path = `${basePath}/network`;
        }
        let params = new HttpParams();
        if (fromBlock) {
            params = params.set('from_block', '' + fromBlock);
        }
        if (toBlock) {
            params = params.set('to_block', '' + toBlock);
        }
        return this.http.get<Array<Event>>(
            `${this.raidenConfig.api}/${path}`,
            {params}
        ).pipe(
            catchError((error) => this.handleError(error)),
        );
    }

    public swapTokens(swap: SwapToken): Observable<boolean> {
        const data = {
            role: swap.role,
            sending_token: swap.sending_token,
            sending_amount: swap.sending_amount,
            receiving_token: swap.receiving_token,
            receiving_amount: swap.receiving_amount,
        };
        return this.http.put(
            `${this.raidenConfig.api}/token_swaps/${swap.partner_address}/${swap.identifier}`,
            data,
            {observe: 'response'},
        ).pipe(
            switchMap((response) => response.ok ? of(true) : throwError(response.toString())),
            catchError((error) => this.handleError(error)),
        );
    }

    public blocknumberToDate(block: number): Observable<Date> {
        return fromPromise(this.raidenConfig.web3.eth.getBlock(block)).pipe(
            map((blk: Block) => new Date(blk.timestamp * 1000)),
            first(),
        );
    }

    public getUserToken(tokenAddress: string): UserToken | null {
        return this.userTokens[tokenAddress];
    }

    private handleError(error: Response | Error | any) {
        // In a real world app, you might use a remote logging infrastructure
        let errMsg: string;
        if (error instanceof Response) {
            let body;
            try {
                body = error.json() || '';
            } catch (e) {
                body = error.text();
            }
            const err = body || JSON.stringify(body);
            errMsg = `${error.status} - ${error.statusText || ''} ${err}`;
        } else if (error instanceof HttpErrorResponse && error.error['errors']) {
            const errors = error.error.errors;

            if (typeof errors === 'string') {
                errMsg = errors;
            } else if (typeof errors === 'object') {
                errMsg = '';

                for (const key in errors) {
                    if (errors.hasOwnProperty(key)) {
                        if (errMsg !== '') {
                            errMsg += '\n';
                        }
                        errMsg += `${key}: ${errors[key]}`;
                    }
                }

            } else {
                errMsg = errors;
            }

        } else {
            errMsg = error.message ? error.message : error.toString();
        }
        console.error(errMsg);
        this.sharedService.error({
            title: 'Raiden Error',
            description: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)
        });
        return throwError(errMsg);
    }
}
